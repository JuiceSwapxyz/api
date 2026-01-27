import Logger from 'bunyan';
import { ethers } from 'ethers';
import { NONFUNGIBLE_POSITION_MANAGER_ADDRESSES, Token, WETH9 } from '@juiceswapxyz/sdk-core';
import { ADDRESS_ZERO, nearestUsableTick } from '@juiceswapxyz/v3-sdk';
import { RouterService } from '../../core/RouterService';
import { getPonderClient } from '../../services/PonderClient';
import { JuiceGatewayService } from '../../services/JuiceGatewayService';
import { getPoolInstance } from '../../utils/poolFactory';
import { fetchV3OnchainPoolInfo } from '../../utils/v3OnchainPositionInfo';

export const TICK_SPACING: Record<number, number> = {
  100: 1,
  500: 10,
  3000: 60,
  10000: 200,
};

export interface V3LpPoolInfoInput {
  tickSpacing?: number;
  token0: string; // can be ADDRESS_ZERO
  token1: string; // can be ADDRESS_ZERO
  fee: number;
}

export interface V3LpPositionInput {
  tickLower: number;
  tickUpper: number;
  pool: V3LpPoolInfoInput;
}

type ErrResult = { ok: false; status: number; message: string; error: string };
type OkResult<T> = { ok: true; data: T };

export type V3LpContextResult = OkResult<{
  provider: any;
  positionManagerAddress: string;
  token0Addr: string;
  token1Addr: string;
  token0: Token;
  token1: Token;
  poolInstance: any;
  tickLower: number;
  tickUpper: number;
  poolAddress: string;
}> | ErrResult;

export function getTokenAddress(token: string, chainId: number) {
  const address = token === ADDRESS_ZERO ? WETH9[chainId].address : token;
  return ethers.utils.getAddress(address);
}

export async function getV3LpContext(params: {
  routerService: RouterService;
  logger: Logger;
  chainId: number;
  tokenId: string | number;
  position: V3LpPositionInput;
  juiceGatewayService?: JuiceGatewayService;
}): Promise<V3LpContextResult> {
  const { routerService, logger, chainId, tokenId, position, juiceGatewayService } = params;

  const provider = routerService.getProvider(chainId);
  if (!provider) {
    return { ok: false, status: 400, message: 'Invalid chainId', error: 'InvalidChainId' };
  }

  const positionManagerAddress = NONFUNGIBLE_POSITION_MANAGER_ADDRESSES[chainId];
  if (!positionManagerAddress) {
    return { ok: false, status: 400, message: 'Unsupported chain for LP operations', error: 'UnsupportedChain' };
  }

  // Map JUSD → svJUSD for internal pool token lookups (Ponder only indexes svJUSD)
  const token0Input = juiceGatewayService?.getInternalPoolToken(chainId, position.pool.token0)
                    ?? position.pool.token0;
  const token1Input = juiceGatewayService?.getInternalPoolToken(chainId, position.pool.token1)
                    ?? position.pool.token1;
  const token0Addr = getTokenAddress(token0Input, chainId);
  const token1Addr = getTokenAddress(token1Input, chainId);
  if (token0Addr.toLowerCase() >= token1Addr.toLowerCase()) {
    return { ok: false, status: 400, message: 'token0 must be < token1 by address', error: 'TokenOrderInvalid' };
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
    return { ok: false, status: 400, message: 'Token not found', error: 'TokenNotFound' };
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
    return { ok: false, status: 400, message: 'Invalid pool instance', error: 'InvalidPoolInstance' };
  }

  const spacing = TICK_SPACING[position.pool.fee] ?? position.pool.tickSpacing;
  if (spacing === undefined) {
    return { ok: false, status: 400, message: 'Unsupported fee tier', error: 'UnsupportedFee' };
  }

  const tickLower = nearestUsableTick(position.tickLower, spacing);
  const tickUpper = nearestUsableTick(position.tickUpper, spacing);
  if (tickLower >= tickUpper) {
    return { ok: false, status: 400, message: 'Invalid tick range: tickLower < tickUpper', error: 'InvalidTickRange' };
  }

  return {
    ok: true,
    data: {
      provider,
      positionManagerAddress,
      token0Addr,
      token1Addr,
      token0,
      token1,
      poolInstance,
      tickLower,
      tickUpper,
      poolAddress: positionData.poolAddress,
    },
  };
}

// Citrea has a block gas limit of 10M, so we cap at 9.5M to be safe
const CITREA_MAX_GAS_LIMIT = ethers.BigNumber.from('9500000');

export async function estimateEip1559Gas(params: {
  provider: any;
  tx: { to: string; from: string; data: string; value: ethers.BigNumberish };
  logger: Logger;
  chainId?: number;
}): Promise<{
  gasLimit: ethers.BigNumber;
  maxFeePerGas: ethers.BigNumber;
  maxPriorityFeePerGas: ethers.BigNumber;
  gasFee: ethers.BigNumber;
}> {
  const { provider, tx, logger, chainId } = params;

  const feeData = await provider.getFeeData();

  let gasEstimate = ethers.BigNumber.from('650000');
  try {
    gasEstimate = await provider.estimateGas(tx);
  } catch (_e) {
    logger.warn('Gas estimation failed, using fallback');
  }

  let gasLimit = gasEstimate.mul(110).div(100);

  // Cap gas limit for Citrea chains (4114 mainnet, 5115 testnet) to stay under block gas limit
  if (chainId === 4114 || chainId === 5115) {
    if (gasLimit.gt(CITREA_MAX_GAS_LIMIT)) {
      logger.warn({ chainId, estimated: gasLimit.toString(), capped: CITREA_MAX_GAS_LIMIT.toString() },
        'Gas limit exceeded Citrea block limit, capping');
      gasLimit = CITREA_MAX_GAS_LIMIT;
    }
  }

  const baseFee = feeData.lastBaseFeePerGas || ethers.utils.parseUnits('0.00000136', 'gwei');
  const maxPriorityFeePerGas = ethers.utils.parseUnits('1', 'gwei');
  const maxFeePerGas = baseFee.mul(105).div(100).add(maxPriorityFeePerGas);

  const gasFee = gasLimit.mul(maxFeePerGas);

  return { gasLimit, maxFeePerGas, maxPriorityFeePerGas, gasFee };
}

