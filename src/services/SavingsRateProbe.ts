import { ethers } from "ethers";
import { ChainId } from "@juiceswapxyz/sdk-core";
import Logger from "bunyan";

const SAVINGS_VAULT_ABI = ["function SAVINGS() view returns (address)"];
const SAVINGS_ABI = ["function currentRatePPM() view returns (uint24)"];
const DEFAULT_SAVINGS_RATE_CACHE_TTL_MS = 60_000;

export interface SavingsRateProbeResult {
  rate: ethers.BigNumber;
  address: string | null;
}

export interface SavingsRateProbeMetrics {
  probeFailures: number;
  currentRatePpm: Record<string, number>;
}

export type SavingsRateContractFactory = (
  address: string,
  abi: string[],
  provider: ethers.providers.Provider,
) => ethers.Contract;

interface SavingsRateProbeOptions {
  ttlMs?: number;
  contractFactory?: SavingsRateContractFactory;
}

interface CacheEntry {
  rate: ethers.BigNumber;
  fetchedAt: number;
  address: string | null;
}

export class SavingsRateProbe {
  private logger: Logger;
  private ttlMs: number;
  private contractFactory: SavingsRateContractFactory;
  private vaultContracts: Map<ChainId, ethers.Contract> = new Map();
  private cache: Map<ChainId, CacheEntry> = new Map();
  private overrides: Map<
    ChainId,
    { rate: ethers.BigNumber; address: string | null }
  > = new Map();
  private inFlight: Map<ChainId, Promise<SavingsRateProbeResult>> = new Map();
  private probeFailures = 0;
  private ratePpmByChain: Map<ChainId, number> = new Map();

  constructor(logger: Logger, options: SavingsRateProbeOptions = {}) {
    this.logger = logger.child({ service: "SavingsRateProbe" });
    this.ttlMs = options.ttlMs ?? DEFAULT_SAVINGS_RATE_CACHE_TTL_MS;
    this.contractFactory =
      options.contractFactory ??
      ((address, abi, provider) => new ethers.Contract(address, abi, provider));
  }

  registerVault(
    chainId: ChainId,
    vaultAddress: string,
    provider: ethers.providers.Provider,
  ): void {
    this.vaultContracts.set(
      chainId,
      this.contractFactory(vaultAddress, SAVINGS_VAULT_ABI, provider),
    );
  }

  setOverride(
    chainId: ChainId,
    rate: ethers.BigNumberish,
    address: string | null = null,
  ): void {
    const rateBn = ethers.BigNumber.from(rate);
    this.overrides.set(chainId, { rate: rateBn, address });
    this.cache.delete(chainId);
    this.ratePpmByChain.set(chainId, rateBn.toNumber());
  }

  clearOverride(chainId?: ChainId): void {
    if (chainId === undefined) {
      // Drop the override-seeded gauge values too so /metrics never reports a
      // stale forced rate after the override is lifted.
      for (const overriddenChain of this.overrides.keys()) {
        this.ratePpmByChain.delete(overriddenChain);
      }
      this.overrides.clear();
      return;
    }
    if (this.overrides.delete(chainId)) {
      this.ratePpmByChain.delete(chainId);
    }
  }

  /**
   * Telemetry snapshot for the /metrics endpoint.
   * - probeFailures: number of failed currentRatePPM probes since startup.
   * - currentRatePpm: last observed savings rate per chainId.
   */
  getMetrics(): SavingsRateProbeMetrics {
    const currentRatePpm: Record<string, number> = {};
    for (const [chainId, rate] of this.ratePpmByChain) {
      currentRatePpm[String(chainId)] = rate;
    }
    return { probeFailures: this.probeFailures, currentRatePpm };
  }

  /**
   * Resolve once every in-flight background refresh has settled.
   * Used by tests and for graceful diagnostics; production callers never await it.
   */
  async idle(): Promise<void> {
    await Promise.all(
      Array.from(this.inFlight.values()).map((task) =>
        task.catch(() => undefined),
      ),
    );
  }

  async getCurrentRate(
    chainId: ChainId,
    savingsVaultAddress: string | null,
  ): Promise<SavingsRateProbeResult> {
    const override = this.overrides.get(chainId);
    if (override) {
      return { rate: override.rate, address: override.address };
    }

    const cached = this.cache.get(chainId);
    if (cached && Date.now() - cached.fetchedAt < this.ttlMs) {
      return { rate: cached.rate, address: cached.address };
    }

    const vaultContract = this.vaultContracts.get(chainId);
    if (!vaultContract || !vaultContract.provider) {
      if (cached) {
        return { rate: cached.rate, address: cached.address };
      }
      // Fail open: no integration vault registered, so we cannot prove the
      // rate is zero. Blocking here would brick still-working chains.
      this.logger.warn(
        { chainId, savingsVaultAddress },
        "Savings vault not registered; allowing Gateway deposit route (fail-open)",
      );
      return { rate: ethers.constants.One, address: null };
    }

    if (cached) {
      // Stale-while-revalidate: hand back the stale rate immediately and
      // refresh in the background so request latency never pays for the probe.
      void this.getOrStartRefresh(
        chainId,
        vaultContract,
        savingsVaultAddress,
      ).catch(() => undefined);
      return { rate: cached.rate, address: cached.address };
    }

    // Cold cache: coalesce concurrent first-callers onto one shared probe so
    // a burst of startup requests can't stampede the RPC (thundering herd).
    return this.getOrStartRefresh(
      chainId,
      vaultContract,
      savingsVaultAddress,
    );
  }

  private getOrStartRefresh(
    chainId: ChainId,
    vaultContract: ethers.Contract,
    savingsVaultAddress: string | null,
  ): Promise<SavingsRateProbeResult> {
    const existing = this.inFlight.get(chainId);
    if (existing) return existing;
    const task = this.refresh(
      chainId,
      vaultContract,
      savingsVaultAddress,
    ).finally(() => {
      this.inFlight.delete(chainId);
    });
    this.inFlight.set(chainId, task);
    return task;
  }

  private async refresh(
    chainId: ChainId,
    vaultContract: ethers.Contract,
    savingsVaultAddress: string | null,
  ): Promise<SavingsRateProbeResult> {
    const cached = this.cache.get(chainId);
    let savingsAddress: string | null = null;
    let rate: ethers.BigNumber;
    try {
      const probedSavingsAddress = await vaultContract.SAVINGS();
      savingsAddress = probedSavingsAddress;
      const savingsContract = this.contractFactory(
        probedSavingsAddress,
        SAVINGS_ABI,
        vaultContract.provider,
      );
      rate = ethers.BigNumber.from(await savingsContract.currentRatePPM());
    } catch (error) {
      this.probeFailures += 1;
      if (cached) {
        this.logger.warn(
          {
            chainId,
            savingsVaultAddress,
            savingsAddress,
            cachedRate: cached.rate.toString(),
            cachedSavingsAddress: cached.address,
            error,
          },
          "Savings currentRatePPM probe failed; using stale cached rate",
        );
        return { rate: cached.rate, address: cached.address };
      }

      this.logger.warn(
        { chainId, savingsVaultAddress, savingsAddress, error },
        "Savings currentRatePPM probe failed; blocking Gateway deposit route",
      );
      return { rate: ethers.constants.Zero, address: savingsAddress };
    }

    this.cache.set(chainId, {
      rate,
      fetchedAt: Date.now(),
      address: savingsAddress,
    });
    this.ratePpmByChain.set(chainId, rate.toNumber());
    return { rate, address: savingsAddress };
  }
}
