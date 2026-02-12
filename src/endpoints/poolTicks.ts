import { Request, Response } from "express";
import Logger from "bunyan";
import { getAddress } from "viem";
import { ethers } from "ethers";

const TICK_LENS_ADDRESSES: Record<number, string> = {
  4114: "0xD9d430f27F922A3316d22Cd9d58558f45Dad8012",
  5115: "0x00Ba410Bd715d0D9F9eFAbC65c7df8F0C5D4E7Eb",
};

const TICK_LENS_ABI = [
  {
    inputs: [
      { name: "pool", type: "address" },
      { name: "tickBitmapIndex", type: "int16" },
    ],
    name: "getPopulatedTicksInWord",
    outputs: [
      {
        components: [
          { name: "tick", type: "int24" },
          { name: "liquidityNet", type: "int128" },
          { name: "liquidityGross", type: "uint128" },
        ],
        name: "populatedTicks",
        type: "tuple[]",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
];

const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
  "function tickSpacing() view returns (int24)",
];

export function createPoolTicksHandler(
  providers: Map<number, ethers.providers.StaticJsonRpcProvider>,
  logger: Logger,
) {
  return async function handlePoolTicks(
    req: Request,
    res: Response,
  ): Promise<void> {
    const log = logger.child({ endpoint: "poolTicks" });

    try {
      const poolAddress = getAddress(req.params.address);
      const chainId = parseInt(req.query.chainId as string) || 4114;

      const provider = providers.get(chainId);
      if (!provider) {
        res.status(400).json({ error: `No provider for chainId ${chainId}` });
        return;
      }

      const tickLensAddress = TICK_LENS_ADDRESSES[chainId];
      if (!tickLensAddress) {
        res
          .status(400)
          .json({ error: `No TickLens contract for chainId ${chainId}` });
        return;
      }

      const poolContract = new ethers.Contract(poolAddress, POOL_ABI, provider);

      let slot0: any;
      let liquidity: any;
      let tickSpacingValue: number;
      try {
        [slot0, liquidity, tickSpacingValue] = await Promise.all([
          poolContract.slot0(),
          poolContract.liquidity(),
          poolContract.tickSpacing(),
        ]);
      } catch (error) {
        log.warn({ error, poolAddress }, "Pool contract call failed");
        res.status(404).json({ error: "Pool not found" });
        return;
      }

      const currentTick = slot0.tick;
      const sqrtPriceX96 = slot0.sqrtPriceX96.toString();
      const poolLiquidity = liquidity.toString();
      const tickSpacing =
        typeof tickSpacingValue === "number"
          ? tickSpacingValue
          : ethers.BigNumber.from(tickSpacingValue).toNumber();

      // Calculate bitmap word range: 20 words in each direction from current tick
      const compressedTick = Math.floor(currentTick / tickSpacing);
      // Arithmetic right shift for negative support
      const currentWordIndex = compressedTick >> 8;
      const minWord = currentWordIndex - 20;
      const maxWord = currentWordIndex + 20;

      const tickLensContract = new ethers.Contract(
        tickLensAddress,
        TICK_LENS_ABI,
        provider,
      );

      // Fetch populated ticks for each word
      const wordPromises: Promise<any>[] = [];
      for (let wordIndex = minWord; wordIndex <= maxWord; wordIndex++) {
        wordPromises.push(
          tickLensContract
            .getPopulatedTicksInWord(poolAddress, wordIndex)
            .catch(() => []),
        );
      }

      const wordResults = await Promise.all(wordPromises);

      // Flatten and sort ticks
      const allTicks: Array<{
        tick: number;
        liquidityNet: string;
        liquidityGross: string;
      }> = [];

      for (const wordTicks of wordResults) {
        if (!wordTicks || !Array.isArray(wordTicks)) {
          continue;
        }
        for (const t of wordTicks) {
          allTicks.push({
            tick:
              typeof t.tick === "number"
                ? t.tick
                : ethers.BigNumber.from(t.tick).toNumber(),
            liquidityNet: t.liquidityNet.toString(),
            liquidityGross: t.liquidityGross.toString(),
          });
        }
      }

      allTicks.sort((a, b) => a.tick - b.tick);

      res.json({
        ticks: allTicks,
        pool: {
          tick: currentTick,
          sqrtPriceX96,
          liquidity: poolLiquidity,
          tickSpacing,
        },
      });
    } catch (error) {
      log.error({ error }, "Failed to get pool ticks");
      res.status(500).json({
        error: "Internal server error",
        detail:
          error instanceof Error ? error.message : "Unknown error occurred",
      });
    }
  };
}
