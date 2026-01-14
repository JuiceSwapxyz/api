import { Request, Response } from 'express';
import Logger from 'bunyan';
import { ethers } from 'ethers';
import JSBI from 'jsbi';
import { RouterService } from '../core/RouterService';
import { CurrencyAmount, Percent, Ether } from '@juiceswapxyz/sdk-core';
import { ADDRESS_ZERO, NonfungiblePositionManager, Position } from '@juiceswapxyz/v3-sdk';
import { estimateEip1559Gas, getV3LpContext, V3LpPositionInput } from './_shared/v3LpCommon';

type IndependentToken = 'TOKEN_0' | 'TOKEN_1';

interface LpIncreaseRequestBody {
  simulateTransaction?: boolean;
  protocol: 'V3';
  walletAddress: string;
  chainId: number;
  tokenId: string; // NFT position tokenId
  independentAmount: string;
  independentToken: IndependentToken;
  position: V3LpPositionInput;
}

const isNativeCurrencyPair = (token0: string, token1: string) => token0 === ADDRESS_ZERO || token1 === ADDRESS_ZERO;

/**
 * @swagger
 * /v1/lp/increase:
 *   post:
 *     tags: [Liquidity]
 *     summary: Increase liquidity for an existing V3 LP position
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/LpIncreaseRequest'
 *           example:
 *             protocol: "V3"
 *             walletAddress: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
 *             chainId: 5115
 *             tokenId: "1234"
 *             independentAmount: "1000000000000000000"
 *             independentToken: "TOKEN_0"
 *             position:
 *               tickLower: -887220
 *               tickUpper: 887220
 *               pool:
 *                 token0: "0xFdB0a83d94CD65151148a131167Eb499Cb85d015"
 *                 token1: "0x4370e27F7d91D9341bFf232d7Ee8bdfE3a9933a0"
 *                 fee: 3000
 *             simulateTransaction: false
 *     responses:
 *       200:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/LpIncreaseResponse'
 *       default:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
export function createLpIncreaseHandler(routerService: RouterService, logger: Logger) {
  return async function handleLpIncrease(req: Request, res: Response): Promise<void> {
    const log = logger.child({ endpoint: 'lp_increase' });

    try {
      const {
        walletAddress,
        chainId,
        tokenId,
        independentAmount,
        independentToken,
        position,
      }: LpIncreaseRequestBody = req.body;

      if (
        !walletAddress ||
        !chainId ||
        !tokenId ||
        !independentAmount ||
        !independentToken ||
        !position ||
        !position?.pool?.token0 ||
        !position?.pool?.token1 ||
        position?.pool?.fee === undefined ||
        position?.tickLower === undefined ||
        position?.tickUpper === undefined
      ) {
        log.debug({ walletAddress, chainId, tokenId, independentAmount, independentToken, position }, 'Validation failed: missing required fields for LP increase');
        res.status(400).json({ message: 'Missing required fields', error: 'MissingRequiredFields' });
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

      const { provider, positionManagerAddress, token0, token1, poolInstance, tickLower, tickUpper } = ctx.data;

      const independentIsToken0 = independentToken === 'TOKEN_0';

      // Compute the dependent amount from pool state
      let positionCalc: Position;
      let amount0Raw: string, amount1Raw: string;

      if (independentIsToken0) {
        positionCalc = Position.fromAmount0({
          pool: poolInstance,
          tickLower,
          tickUpper,
          amount0: JSBI.BigInt(independentAmount),
          useFullPrecision: false,
        });
        amount0Raw = independentAmount;
        amount1Raw = positionCalc.amount1.quotient.toString();
      } else {
        positionCalc = Position.fromAmount1({
          pool: poolInstance,
          tickLower,
          tickUpper,
          amount1: JSBI.BigInt(independentAmount),
        });
        amount0Raw = positionCalc.amount0.quotient.toString();
        amount1Raw = independentAmount;
      }

      const amount0 = CurrencyAmount.fromRawAmount(token0, amount0Raw);
      const amount1 = CurrencyAmount.fromRawAmount(token1, amount1Raw);

      if (JSBI.equal(amount0.quotient, JSBI.BigInt(0)) && JSBI.equal(amount1.quotient, JSBI.BigInt(0))) {
        res.status(400).json({ message: 'Both token amounts cannot be zero', error: 'InvalidAmounts' });
        return;
      }

      const positionToAdd = Position.fromAmounts({
        pool: poolInstance,
        tickLower,
        tickUpper,
        amount0: amount0.quotient,
        amount1: amount1.quotient,
        useFullPrecision: false,
      });

      const slippageTolerance = new Percent(50, 10_000);
      const deadline = Math.floor(Date.now() / 1000) + 60 * 20;

      const useNative = isNativeCurrencyPair(position.pool.token0, position.pool.token1) ? Ether.onChain(chainId) : undefined;

      const { calldata, value } = NonfungiblePositionManager.addCallParameters(positionToAdd, {
        tokenId,
        deadline,
        slippageTolerance,
        useNative,
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
        requestId: `lp-increase-${Date.now()}`,
        increase: {
          to: positionManagerAddress,
          from: walletAddress,
          data: calldata,
          value,
          maxFeePerGas: maxFeePerGas.toHexString(),
          maxPriorityFeePerGas: maxPriorityFeePerGas.toHexString(),
          gasLimit: gasLimit.toHexString(),
          chainId,
        },
        dependentAmount: independentIsToken0 ? amount1.quotient.toString() : amount0.quotient.toString(),
        gasFee: ethers.utils.formatEther(gasFee),
      });

      log.debug({ chainId, walletAddress, tokenId }, 'LP increase request completed');
    } catch (error: any) {
      log.error({ error }, 'Error in handleLpIncrease');
      res.status(500).json({ message: 'Internal server error', error: error?.message });
    }
  };
}

