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
    const second = await probe.getCurrentRate(chainId, vaultAddress);

    expect(first.rate.toString()).toBe("0");
    expect(second.rate.toString()).toBe("0");
    expect(second.address).toBe(savingsAddress);
    expect(currentRatePPM).toHaveBeenCalledTimes(2);
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
});
