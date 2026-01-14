import { Request, Response } from 'express';
import Logger from 'bunyan';
import { ethers } from 'ethers';
import JSBI from 'jsbi';
import { RouterService } from '../core/RouterService';
import { CurrencyAmount, Percent, Ether } from '@juiceswapxyz/sdk-core';
import { ADDRESS_ZERO, NonfungiblePositionManager, Position } from '@juiceswapxyz/v3-sdk';
import { estimateEip1559Gas, getV3LpContext, V3LpPositionInput } from './_shared/v3LpCommon';

interface LpDecreaseRequestBody {
  simulateTransaction?: boolean;
  protocol: 'V3';
  tokenId: number;
  chainId: number;
  walletAddress: string;
  liquidityPercentageToDecrease: number; // 0-100 (supports up to 2 decimals)
  positionLiquidity: string; // raw liquidity as integer string
  expectedTokenOwed0RawAmount: string; // raw amount as integer string
  expectedTokenOwed1RawAmount: string; // raw amount as integer string
  position: V3LpPositionInput;
}

/**
 * @swagger
 * /v1/lp/decrease:
 *   post:
 *     tags: [Liquidity]
 *     summary: Decrease liquidity for an existing V3 LP position (and collect)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/LpDecreaseRequest'
 *           example:
 *             simulateTransaction: true
 *             protocol: "V3"
 *             tokenId: 210447
 *             chainId: 11155111
 *             walletAddress: "0x456037F8830454E0eC54ad3D55c741383862D0c7"
 *             liquidityPercentageToDecrease: 25
 *             positionLiquidity: "37945455597966861"
 *             expectedTokenOwed0RawAmount: "0"
 *             expectedTokenOwed1RawAmount: "0"
 *             position:
 *               tickLower: -887220
 *               tickUpper: 887220
 *               pool:
 *                 token0: "0x131a8656275bDd1130E0213414F3DA47C8C2a402"
 *                 token1: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14"
 *                 fee: 3000
 *                 tickSpacing: 60
 *     responses:
 *       200:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/LpDecreaseResponse'
 *       default:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
export function createLpDecreaseHandler(routerService: RouterService, logger: Logger) {
  return async function handleLpDecrease(req: Request, res: Response): Promise<void> {
    const log = logger.child({ endpoint: 'lp_decrease' });

    try {
      const {
        walletAddress,
        chainId,
        tokenId,
        liquidityPercentageToDecrease,
        positionLiquidity,
        expectedTokenOwed0RawAmount,
        expectedTokenOwed1RawAmount,
        position,
      }: LpDecreaseRequestBody = req.body;

      if (
        !walletAddress ||
        !chainId ||
        tokenId === undefined ||
        liquidityPercentageToDecrease === undefined ||
        !positionLiquidity ||
        expectedTokenOwed0RawAmount === undefined ||
        expectedTokenOwed1RawAmount === undefined ||
        !position ||
        !position?.pool?.token0 ||
        !position?.pool?.token1 ||
        position?.pool?.fee === undefined ||
        position?.tickLower === undefined ||
        position?.tickUpper === undefined
      ) {
        log.debug({ walletAddress, chainId, tokenId, liquidityPercentageToDecrease, positionLiquidity, position }, 'Validation failed: missing required fields for LP decrease');
        res.status(400).json({ message: 'Missing required fields', error: 'MissingRequiredFields' });
        return;
      }

      const percentBps = Math.round(liquidityPercentageToDecrease * 100);
      if (percentBps <= 0 || percentBps > 10_000) {
        res.status(400).json({ message: 'liquidityPercentageToDecrease must be > 0 and <= 100', error: 'InvalidLiquidityPercentage' });
        return;
      }

      const ctx = await getV3LpContext({
        routerService,
        logger: log,
        chainId,
        tokenId,
        position,
      });
      if (!ctx.ok) {
        res.status(ctx.status).json({ message: ctx.message, error: ctx.error });
        return;
      }

      const { provider, positionManagerAddress, poolInstance, tickLower, tickUpper, token0, token1 } = ctx.data;

      const positionInstance = new Position({
        pool: poolInstance,
        tickLower,
        tickUpper,
        liquidity: JSBI.BigInt(positionLiquidity),
      });

      const slippageTolerance = new Percent(50, 10_000);
      const deadline = Math.floor(Date.now() / 1000) + 60 * 20;

      const currency0 = position.pool.token0 === ADDRESS_ZERO ? Ether.onChain(chainId) : token0;
      const currency1 = position.pool.token1 === ADDRESS_ZERO ? Ether.onChain(chainId) : token1;

      const expectedCurrencyOwed0 = CurrencyAmount.fromRawAmount(currency0, expectedTokenOwed0RawAmount);
      const expectedCurrencyOwed1 = CurrencyAmount.fromRawAmount(currency1, expectedTokenOwed1RawAmount);

      const { calldata, value } = NonfungiblePositionManager.removeCallParameters(positionInstance, {
        tokenId,
        liquidityPercentage: new Percent(percentBps, 10_000),
        slippageTolerance,
        deadline,
        burnToken: false,
        collectOptions: {
          recipient: walletAddress,
          expectedCurrencyOwed0,
          expectedCurrencyOwed1,
        },
      });

      const { gasLimit, maxFeePerGas, maxPriorityFeePerGas, gasFee } = await estimateEip1559Gas({
        provider,
        tx: {
          to: positionManagerAddress,
          from: walletAddress,
          data: calldata,
          value,
        },
        logger: log,
      });

      res.status(200).json({
        requestId: `lp-decrease-${Date.now()}`,
        decrease: {
          to: positionManagerAddress,
          from: walletAddress,
          data: calldata,
          value,
          maxFeePerGas: maxFeePerGas.toHexString(),
          maxPriorityFeePerGas: maxPriorityFeePerGas.toHexString(),
          gasLimit: gasLimit.toHexString(),
          chainId,
        },
        gasFee: ethers.utils.formatEther(gasFee),
      });

      log.debug({ chainId, walletAddress, tokenId, liquidityPercentageToDecrease }, 'LP decrease request completed');
    } catch (error: any) {
      log.error({ error }, 'Error in handleLpDecrease');
      res.status(500).json({ message: 'Internal server error', error: error?.message });
    }
  };
}

