import { ethers } from "ethers";
import { ChainId } from "@juiceswapxyz/sdk-core";
import Logger from "bunyan";
import { SavingsRateProbe } from "../SavingsRateProbe";
import { JuiceGatewayService } from "../JuiceGatewayService";
import { getChainContracts } from "../../config/contracts";

/**
 * Live integration test against Citrea Mainnet (chain 4114). Opt-in only:
 * set RUN_CITREA_INTEGRATION=1 to run. It hits the public RPC, so it stays
 * out of the deterministic unit-test CI matrix.
 *
 * Verifies the root cause from issue #263 still holds and that the API-side
 * gate reacts to the live Savings rate:
 *   - SavingsRateProbe reads currentRatePPM() == 0 from the on-chain Savings.
 *   - Savings.save(...) reverts with ModuleDisabled() (0x6dff2fe8).
 *   - JUSD -> cBTC is gated (GATEWAY_DEPOSIT_DISABLED) end-to-end.
 *   - JUSD -> CTUSD (direct USD conversion) is NOT gated.
 */
const RUN = process.env.RUN_CITREA_INTEGRATION === "1";
const RPC_URL =
  process.env.CITREA_4114_RPC_URL || "https://rpc.citreascan.com/";
const MODULE_DISABLED_SELECTOR = "0x6dff2fe8"; // keccak256("ModuleDisabled()")[:4]
const SAVINGS_ABI = [
  "function currentRatePPM() view returns (uint24)",
  "function save(address owner, uint192 amount)",
];

function createSilentLogger(): Logger {
  const logger = {
    child: () => logger,
    info: () => undefined,
    debug: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  return logger as unknown as Logger;
}

(RUN ? describe : describe.skip)(
  "SavingsRateProbe (Citrea Mainnet integration)",
  () => {
    jest.setTimeout(60_000);

    const chainId = ChainId.CITREA_MAINNET;
    const contracts = getChainContracts(chainId)!;
    let provider: ethers.providers.StaticJsonRpcProvider;

    beforeAll(() => {
      provider = new ethers.providers.StaticJsonRpcProvider(RPC_URL, {
        chainId,
        name: "citrea-mainnet",
      });
    });

    it("reads currentRatePPM() == 0 from the live Savings contract", async () => {
      const probe = new SavingsRateProbe(createSilentLogger());
      probe.registerVault(chainId, contracts.SV_JUSD, provider);

      const result = await probe.getCurrentRate(chainId, contracts.SV_JUSD);

      // The savings rate has been at 0 since the outage began (issue #263).
      expect(result.rate.isZero()).toBe(true);
      expect(result.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });

    it("Savings.save(...) reverts with ModuleDisabled() (0x6dff2fe8)", async () => {
      const probe = new SavingsRateProbe(createSilentLogger());
      probe.registerVault(chainId, contracts.SV_JUSD, provider);
      const { address: savingsAddress } = await probe.getCurrentRate(
        chainId,
        contracts.SV_JUSD,
      );
      expect(savingsAddress).not.toBeNull();

      const savings = new ethers.Contract(
        savingsAddress as string,
        SAVINGS_ABI,
        provider,
      );

      let revertData = "";
      try {
        await savings.callStatic.save(
          "0x000000000000000000000000000000000000dEaD",
          ethers.utils.parseUnits("1", 18),
        );
        throw new Error("save() did not revert");
      } catch (error) {
        revertData = JSON.stringify(error);
      }

      expect(revertData).toContain(MODULE_DISABLED_SELECTOR);
    });

    it("gates JUSD -> cBTC but not JUSD -> CTUSD against live state", async () => {
      const service = new JuiceGatewayService(
        new Map([[chainId, provider]]),
        createSilentLogger(),
      );

      // Deposit-bound route must be rejected.
      await expect(
        service.rejectIfRouteRequiresJusdDepositDisabled(
          chainId,
          contracts.JUSD,
          contracts.WCBTC,
          "GATEWAY_JUSD",
        ),
      ).rejects.toMatchObject({ code: "GATEWAY_DEPOSIT_DISABLED" });

      // Direct USD conversion bypasses the vault and must stay available.
      await expect(
        service.rejectIfRouteRequiresJusdDepositDisabled(
          chainId,
          contracts.JUSD,
          contracts.CTUSD,
          "GATEWAY_JUSD",
        ),
      ).resolves.toBeUndefined();
    });
  },
);
