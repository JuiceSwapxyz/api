import { ethers } from "ethers";
import { ChainId } from "@juiceswapxyz/sdk-core";
import Logger from "bunyan";
import {
  SavingsRateContractFactory,
  SavingsRateProbe,
} from "../SavingsRateProbe";

function createMockLogger(): Logger {
  const logger = {
    child: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  logger.child.mockReturnValue(logger);
  return logger as unknown as Logger;
}

describe("SavingsRateProbe", () => {
  const chainId = ChainId.CITREA_MAINNET;
  const vaultAddress = "0x0000000000000000000000000000000000000001";
  const savingsAddress = "0x0000000000000000000000000000000000000002";

  it("returns the runtime override without requiring an RPC contract", async () => {
    const probe = new SavingsRateProbe(createMockLogger());

    probe.setOverride(chainId, 0, savingsAddress);

    const result = await probe.getCurrentRate(chainId, vaultAddress);
    expect(result.rate.isZero()).toBe(true);
    expect(result.address).toBe(savingsAddress);
  });

  it("caches the probed rate within the configured TTL", async () => {
    const savings = jest.fn().mockResolvedValue(savingsAddress);
    const currentRatePPM = jest
      .fn()
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(123);
    const factory: SavingsRateContractFactory = (address, abi, provider) => {
      if (abi[0].includes("SAVINGS()")) {
        expect(address).toBe(vaultAddress);
        return { provider, SAVINGS: savings } as unknown as ethers.Contract;
      }
      expect(address).toBe(savingsAddress);
      return {
        provider,
        currentRatePPM,
      } as unknown as ethers.Contract;
    };
    const probe = new SavingsRateProbe(createMockLogger(), {
      ttlMs: 60_000,
      contractFactory: factory,
    });

    probe.registerVault(chainId, vaultAddress, {} as ethers.providers.Provider);

    const first = await probe.getCurrentRate(chainId, vaultAddress);
    const second = await probe.getCurrentRate(chainId, vaultAddress);

    expect(first.rate.toString()).toBe("0");
    expect(second.rate.toString()).toBe("0");
    expect(savings).toHaveBeenCalledTimes(1);
    expect(currentRatePPM).toHaveBeenCalledTimes(1);
  });

  it("keeps a stale cached zero rate when refresh probing fails", async () => {
    const savings = jest.fn().mockResolvedValue(savingsAddress);
    const currentRatePPM = jest
      .fn()
      .mockResolvedValueOnce(0)
      .mockRejectedValueOnce(new Error("rpc unavailable"));
    const factory: SavingsRateContractFactory = (address, abi, provider) => {
      if (abi[0].includes("SAVINGS()")) {
        return { provider, SAVINGS: savings } as unknown as ethers.Contract;
      }
      expect(address).toBe(savingsAddress);
      return {
        provider,
        currentRatePPM,
      } as unknown as ethers.Contract;
    };
    const probe = new SavingsRateProbe(createMockLogger(), {
      ttlMs: 0,
      contractFactory: factory,
    });

    probe.registerVault(chainId, vaultAddress, {} as ethers.providers.Provider);

    const first = await probe.getCurrentRate(chainId, vaultAddress);
    // Stale entry is served immediately; the failing refresh runs in the
    // background and must not overwrite the cached value.
    const second = await probe.getCurrentRate(chainId, vaultAddress);
    await probe.idle();

    expect(first.rate.toString()).toBe("0");
    expect(second.rate.toString()).toBe("0");
    expect(second.address).toBe(savingsAddress);
    expect(currentRatePPM).toHaveBeenCalledTimes(2);
    expect(probe.getMetrics().probeFailures).toBe(1);
  });

  it("fails closed when an initial probe fails for a registered vault", async () => {
    const savings = jest.fn().mockResolvedValue(savingsAddress);
    const currentRatePPM = jest.fn().mockRejectedValue(new Error("rpc down"));
    const factory: SavingsRateContractFactory = (address, abi, provider) => {
      if (abi[0].includes("SAVINGS()")) {
        return { provider, SAVINGS: savings } as unknown as ethers.Contract;
      }
      expect(address).toBe(savingsAddress);
      return {
        provider,
        currentRatePPM,
      } as unknown as ethers.Contract;
    };
    const probe = new SavingsRateProbe(createMockLogger(), {
      contractFactory: factory,
    });

    probe.registerVault(chainId, vaultAddress, {} as ethers.providers.Provider);

    const result = await probe.getCurrentRate(chainId, vaultAddress);

    expect(result.rate.isZero()).toBe(true);
    expect(result.address).toBe(savingsAddress);
  });

  it("fails open when no vault has been registered", async () => {
    const probe = new SavingsRateProbe(createMockLogger());

    const result = await probe.getCurrentRate(chainId, vaultAddress);

    expect(result.rate.eq(ethers.constants.One)).toBe(true);
    expect(result.address).toBeNull();
  });

  it("serves a stale rate immediately and revalidates in the background", async () => {
    const savings = jest.fn().mockResolvedValue(savingsAddress);
    const currentRatePPM = jest
      .fn()
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(123);
    const factory: SavingsRateContractFactory = (address, abi, provider) => {
      if (abi[0].includes("SAVINGS()")) {
        return { provider, SAVINGS: savings } as unknown as ethers.Contract;
      }
      return {
        provider,
        currentRatePPM,
      } as unknown as ethers.Contract;
    };
    const probe = new SavingsRateProbe(createMockLogger(), {
      ttlMs: 0,
      contractFactory: factory,
    });

    probe.registerVault(chainId, vaultAddress, {} as ethers.providers.Provider);

    const first = await probe.getCurrentRate(chainId, vaultAddress);
    const second = await probe.getCurrentRate(chainId, vaultAddress);
    await probe.idle();

    // The stale (0) rate is returned synchronously; the fresh 123 only lands
    // in the cache/gauge after the background refresh settles.
    expect(first.rate.toString()).toBe("0");
    expect(second.rate.toString()).toBe("0");
    expect(currentRatePPM).toHaveBeenCalledTimes(2);
    expect(probe.getMetrics().currentRatePpm[String(chainId)]).toBe(123);
  });

  it("coalesces concurrent background refreshes into one probe", async () => {
    const savings = jest.fn().mockResolvedValue(savingsAddress);
    const currentRatePPM = jest
      .fn()
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(123);
    const factory: SavingsRateContractFactory = (address, abi, provider) => {
      if (abi[0].includes("SAVINGS()")) {
        return { provider, SAVINGS: savings } as unknown as ethers.Contract;
      }
      return {
        provider,
        currentRatePPM,
      } as unknown as ethers.Contract;
    };
    const probe = new SavingsRateProbe(createMockLogger(), {
      ttlMs: 0,
      contractFactory: factory,
    });

    probe.registerVault(chainId, vaultAddress, {} as ethers.providers.Provider);

    await probe.getCurrentRate(chainId, vaultAddress); // cold blocking probe
    await probe.getCurrentRate(chainId, vaultAddress); // schedules one refresh
    await probe.getCurrentRate(chainId, vaultAddress); // in-flight, no extra probe
    await probe.idle();

    // 1 cold probe + 1 coalesced background refresh = 2 (never 3).
    expect(currentRatePPM).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent cold-cache callers into one probe (no thundering herd)", async () => {
    const savings = jest.fn().mockResolvedValue(savingsAddress);
    const currentRatePPM = jest.fn().mockResolvedValue(42);
    const factory: SavingsRateContractFactory = (address, abi, provider) => {
      if (abi[0].includes("SAVINGS()")) {
        return { provider, SAVINGS: savings } as unknown as ethers.Contract;
      }
      return {
        provider,
        currentRatePPM,
      } as unknown as ethers.Contract;
    };
    const probe = new SavingsRateProbe(createMockLogger(), {
      ttlMs: 60_000,
      contractFactory: factory,
    });

    probe.registerVault(chainId, vaultAddress, {} as ethers.providers.Provider);

    // Three first-callers race before the cache is warm; they must share one
    // SAVINGS()+currentRatePPM() probe rather than each firing its own.
    const [a, b, c] = await Promise.all([
      probe.getCurrentRate(chainId, vaultAddress),
      probe.getCurrentRate(chainId, vaultAddress),
      probe.getCurrentRate(chainId, vaultAddress),
    ]);

    expect(a.rate.toString()).toBe("42");
    expect(b.rate.toString()).toBe("42");
    expect(c.rate.toString()).toBe("42");
    expect(savings).toHaveBeenCalledTimes(1);
    expect(currentRatePPM).toHaveBeenCalledTimes(1);
  });

  it("exposes the override rate through the metrics gauge", async () => {
    const probe = new SavingsRateProbe(createMockLogger());

    probe.setOverride(chainId, 0, savingsAddress);

    expect(probe.getMetrics().currentRatePpm[String(chainId)]).toBe(0);
  });

  it("clears a per-chain override and falls back to normal resolution", async () => {
    const probe = new SavingsRateProbe(createMockLogger());
    probe.setOverride(chainId, 0, savingsAddress);
    expect(
      (await probe.getCurrentRate(chainId, vaultAddress)).rate.isZero(),
    ).toBe(true);

    probe.clearOverride(chainId);

    // The override-seeded gauge value is dropped, not left stale at 0.
    expect(probe.getMetrics().currentRatePpm[String(chainId)]).toBeUndefined();

    // No vault registered after clearing → fail-open rate of 1.
    const result = await probe.getCurrentRate(chainId, vaultAddress);
    expect(result.rate.eq(ethers.constants.One)).toBe(true);
  });

  it("clears every override when called without a chainId", async () => {
    const probe = new SavingsRateProbe(createMockLogger());
    probe.setOverride(chainId, 0, savingsAddress);

    probe.clearOverride();

    const result = await probe.getCurrentRate(chainId, vaultAddress);
    expect(result.rate.eq(ethers.constants.One)).toBe(true);
  });
});
