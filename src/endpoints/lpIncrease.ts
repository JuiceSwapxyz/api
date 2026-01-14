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

type IndependentToken = 'TOKEN_0' | 'TOKEN_1';

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

interface LpIncreaseRequestBody {
  simulateTransaction?: boolean;
  protocol: 'V3';
  walletAddress: string;
  chainId: number;
  tokenId: string; // NFT position tokenId
  independentAmount: string;
  independentToken: IndependentToken;
  position: PositionInfo;
}

const getTokenAddress = (token: string, chainId: number) => {
  const address = token === ADDRESS_ZERO ? WETH9[chainId].address : token;
  return ethers.utils.getAddress(address);
};

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

      const provider = routerService.getProvider(chainId);
      if (!provider) {
        log.debug({ chainId }, 'Validation failed: invalid chainId for LP increase');
        res.status(400).json({ message: 'Invalid chainId', error: 'InvalidChainId' });
        return;
      }

      const positionManagerAddress = NONFUNGIBLE_POSITION_MANAGER_ADDRESSES[chainId];
      if (!positionManagerAddress) {
        res.status(400).json({ message: 'Unsupported chain for LP operations', error: 'UnsupportedChain' });
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
      });

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

