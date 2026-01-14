import { Request, Response } from 'express';
import Logger from 'bunyan';
import { ethers } from 'ethers';
import JSBI from 'jsbi';
import { RouterService } from '../core/RouterService';
import { NONFUNGIBLE_POSITION_MANAGER_ADDRESSES, Token, CurrencyAmount, Percent, WETH9, Ether } from '@juiceswapxyz/sdk-core';
import { ADDRESS_ZERO, NonfungiblePositionManager, Position, nearestUsableTick } from '@juiceswapxyz/v3-sdk';
import { getPoolInstance } from '../utils/poolFactory';
import { getPonderClient } from '../services/PonderClient';
import { fetchV3OnchainPoolInfo } from '../utils/v3OnchainPositionInfo';

const TICK_SPACING: Record<number, number> = {
  100: 1,
  500: 10,
  3000: 60,
  10000: 200,
};

interface PoolInfo {
  tickSpacing?: number;
  token0: string; // can be ADDRESS_ZERO
  token1: string; // can be ADDRESS_ZERO
  fee: number;
}

interface PositionInfo {
  tickLower: number;
  tickUpper: number;
  pool: PoolInfo;
}

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
  position: PositionInfo;
}

const getTokenAddress = (token: string, chainId: number) => {
  const address = token === ADDRESS_ZERO ? WETH9[chainId].address : token;
  return ethers.utils.getAddress(address);
};

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

      const provider = routerService.getProvider(chainId);
      if (!provider) {
        log.debug({ chainId }, 'Validation failed: invalid chainId for LP decrease');
        res.status(400).json({ message: 'Invalid chainId', error: 'InvalidChainId' });
        return;
      }

      const positionManagerAddress = NONFUNGIBLE_POSITION_MANAGER_ADDRESSES[chainId];
      if (!positionManagerAddress) {
        res.status(400).json({ message: 'Unsupported chain for LP operations', error: 'UnsupportedChain' });
        return;
      }

      const percentBps = Math.round(liquidityPercentageToDecrease * 100);
      if (percentBps <= 0 || percentBps > 10_000) {
        res.status(400).json({ message: 'liquidityPercentageToDecrease must be > 0 and <= 100', error: 'InvalidLiquidityPercentage' });
        return;
      }

      const token0Addr = getTokenAddress(position.pool.token0, chainId);
      const token1Addr = getTokenAddress(position.pool.token1, chainId);
      if (token0Addr.toLowerCase() >= token1Addr.toLowerCase()) {
        res.status(400).json({ message: 'token0 must be < token1 by address', error: 'TokenOrderInvalid' });
        return;
      }

      const ponderClient = getPonderClient(logger);
      const positionInfo = await ponderClient.query(
        `
        query QueryInfo($wherePosition: positionFilter = {}, $token0Id: String = "", $token1Id: String = "") {
             positions(where: $wherePosition) {
                items {
                    tickLower
                    tickUpper
                    tokenId
                    poolAddress
                }
            }
            token0: token(id: $token0Id) {
                address
                decimals
                id
                name
                symbol
            }
            token1: token(id: $token1Id) {
                address
                decimals
                id
                name
                symbol
            }
        }
      `,
        {
          wherePosition: {
            tokenId: tokenId.toString(),
          },
          token0Id: token0Addr.toLowerCase(),
          token1Id: token1Addr.toLowerCase(),
        }
      );

      const positionData = positionInfo.positions.items[0];
      const token0Data = positionInfo.token0;
      const token1Data = positionInfo.token1;
      if (!positionData || !token0Data || !token1Data) {
        res.status(400).json({ message: 'Token not found', error: 'TokenNotFound' });
        return;
      }

      const token0 = new Token(chainId, token0Data.address, token0Data.decimals);
      const token1 = new Token(chainId, token1Data.address, token1Data.decimals);

      const onchainPoolInfo = await fetchV3OnchainPoolInfo({
        provider,
        poolAddress: positionData.poolAddress,
      });

      const poolInstance = await getPoolInstance({
        token0,
        token1,
        fee: position.pool.fee,
        chainId,
        provider,
        liquidity: onchainPoolInfo.currentLiquidity,
        tickCurrent: parseInt(onchainPoolInfo.currentTick),
        sqrtPriceX96: onchainPoolInfo.currentPrice,
      });
      if (!poolInstance) {
        res.status(400).json({ message: 'Invalid pool instance', error: 'InvalidPoolInstance' });
        return;
      }

      const spacing = TICK_SPACING[position.pool.fee] ?? position.pool.tickSpacing;
      if (spacing === undefined) {
        res.status(400).json({ message: 'Unsupported fee tier', error: 'UnsupportedFee' });
        return;
      }

      const tickLower = nearestUsableTick(position.tickLower, spacing);
      const tickUpper = nearestUsableTick(position.tickUpper, spacing);
      if (tickLower >= tickUpper) {
        res.status(400).json({ message: 'Invalid tick range: tickLower < tickUpper', error: 'InvalidTickRange' });
        return;
      }

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

      const feeData = await provider.getFeeData();

      let gasEstimate = ethers.BigNumber.from('650000');
      try {
        gasEstimate = await provider.estimateGas({
          to: positionManagerAddress,
          from: walletAddress,
          data: calldata,
          value,
        });
      } catch (_e) {
        log.warn('Gas estimation failed, using fallback');
      }

      const gasLimit = gasEstimate.mul(110).div(100);

      const baseFee = feeData.lastBaseFeePerGas || ethers.utils.parseUnits('0.00000136', 'gwei');
      const maxPriorityFeePerGas = ethers.utils.parseUnits('1', 'gwei');
      const maxFeePerGas = baseFee.mul(105).div(100).add(maxPriorityFeePerGas);

      const gasFee = gasLimit.mul(maxFeePerGas);

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

