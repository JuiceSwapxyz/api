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

export type SavingsRateContractFactory = (
  address: string,
  abi: string[],
  provider: ethers.providers.Provider,
) => ethers.Contract;

interface SavingsRateProbeOptions {
  ttlMs?: number;
  contractFactory?: SavingsRateContractFactory;
}

export class SavingsRateProbe {
  private logger: Logger;
  private ttlMs: number;
  private contractFactory: SavingsRateContractFactory;
  private vaultContracts: Map<ChainId, ethers.Contract> = new Map();
  private cache: Map<
    ChainId,
    { rate: ethers.BigNumber; fetchedAt: number; address: string | null }
  > = new Map();
  private overrides: Map<
    ChainId,
    { rate: ethers.BigNumber; address: string | null }
  > = new Map();

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
    this.overrides.set(chainId, {
      rate: ethers.BigNumber.from(rate),
      address,
    });
    this.cache.delete(chainId);
  }

  clearOverride(chainId?: ChainId): void {
    if (chainId === undefined) {
      this.overrides.clear();
      return;
    }
    this.overrides.delete(chainId);
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
      return { rate: ethers.constants.One, address: null };
    }

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
    return { rate, address: savingsAddress };
  }
}
