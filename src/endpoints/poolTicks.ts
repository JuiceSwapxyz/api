import { Request, Response } from "express";
import Logger from "bunyan";
import { getAddress } from "viem";
import { ethers } from "ethers";
import { getTickLensAddress } from "../config/contracts";

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
      const chainId = req.query.chainId as unknown as number;

      const provider = providers.get(chainId);
      if (!provider) {
        res.status(400).json({ error: `No provider for chainId ${chainId}` });
        return;
      }

      const tickLensAddress = getTickLensAddress(chainId);
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

      // Calculate bitmap word range covering all possible initialized ticks.
      // Full-range positions can have ticks at ±MAX_TICK, so we compute the
      // actual word bounds based on tick spacing, capped to limit RPC calls.
      const MAX_TICK = 887272;
      const MAX_TOTAL_WORDS = 120;
      const halfMax = Math.floor(MAX_TOTAL_WORDS / 2);

      const compressedTick = Math.floor(currentTick / tickSpacing);
      // Arithmetic right shift for negative support
      const currentWordIndex = compressedTick >> 8;

      // Word bounds for the full usable tick range at this tick spacing
      const maxUsableTick =
        Math.floor(MAX_TICK / tickSpacing) * tickSpacing;
      const fullRangeMaxWord = Math.floor(maxUsableTick / tickSpacing) >> 8;
      const fullRangeMinWord = Math.floor(-maxUsableTick / tickSpacing) >> 8;

      // Use the tighter of: ±halfMax words from current, or the full range
      const minWord = Math.max(
        currentWordIndex - halfMax,
        fullRangeMinWord,
      );
      const maxWord = Math.min(
        currentWordIndex + halfMax,
        fullRangeMaxWord,
      );

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
            .catch((err: Error) => {
              log.warn({ wordIndex, error: err.message }, "TickLens word fetch failed");
              return [];
            }),
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

      if (allTicks.length === 0 && poolLiquidity !== "0") {
        log.warn({ poolAddress, currentTick, poolLiquidity }, "No ticks found for pool with non-zero liquidity");
      }

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
