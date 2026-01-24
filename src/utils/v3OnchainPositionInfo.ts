import { Contract, providers } from 'ethers';
import { ChainId, NONFUNGIBLE_POSITION_MANAGER_ADDRESSES, Token } from '@juiceswapxyz/sdk-core';
import { Pool, Position } from '@juiceswapxyz/v3-sdk';

export type V3OnchainPositionInfo = {
  /** Position liquidity (uint128) from NonfungiblePositionManager.positions(tokenId).liquidity */
  liquidity: string;
  /** Pool tick (int24) from pool.slot0().tick */
  currentTick: string;
  /** Pool sqrtPriceX96 (uint160) from pool.slot0().sqrtPriceX96 */
  currentPrice: string;
  /** Pool in-range liquidity (uint128) from pool.liquidity() */
  currentLiquidity: string;
  /** Position tick lower (int24) from NonfungiblePositionManager.positions(tokenId).tickLower */
  tickLower: string;
  /** Position tick upper (int24) from NonfungiblePositionManager.positions(tokenId).tickUpper */
  tickUpper: string;
  /** Position amount0 (uint256) from NonfungiblePositionManager.positions(tokenId).amounts.amount0 */
  amount0: string;
  /** Position amount1 (uint256) from NonfungiblePositionManager.positions(tokenId).amounts.amount1 */
  amount1: string;
};

export type V3OnchainPoolInfo = {
  /** Pool tick (int24) from pool.slot0().tick */
  currentTick: string;
  /** Pool sqrtPriceX96 (uint160) from pool.slot0().sqrtPriceX96 */
  currentPrice: string;
  /** Pool in-range liquidity (uint128) from pool.liquidity() */
  currentLiquidity: string;
};

export type V3OnchainPositionLiquidityInfo = {
  /** Position liquidity (uint128) from NonfungiblePositionManager.positions(tokenId).liquidity */
  liquidity: string;
  /** Position tick lower (int24) from NonfungiblePositionManager.positions(tokenId).tickLower */
  tickLower: string;
  /** Position tick upper (int24) from NonfungiblePositionManager.positions(tokenId).tickUpper */
  tickUpper: string;
  /** Position amount0 (uint256) from NonfungiblePositionManager.positions(tokenId).amounts.amount0 */
};

const V3_POOL_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function liquidity() view returns (uint128)',
];

// Minimal ABI: we only need the returned `liquidity` field (uint128) from `positions(uint256)`.
// The full return tuple is UniswapV3-compatible; extra fields are ignored by ethers if we only read `.liquidity`.
const NONFUNGIBLE_POSITION_MANAGER_ABI = [
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
];

export async function fetchV3OnchainPoolInfo(params: {
  provider: providers.Provider;
  poolAddress: string;
}): Promise<V3OnchainPoolInfo> {
  const { provider, poolAddress } = params;
  const pool = new Contract(poolAddress, V3_POOL_ABI, provider);

  const [slot0, poolLiquidity] = await Promise.all([pool.slot0(), pool.liquidity()]);

  return {
    currentTick: slot0.tick.toString(),
    currentPrice: slot0.sqrtPriceX96.toString(),
    currentLiquidity: poolLiquidity.toString(),
  };
}

export async function fetchV3OnchainPositionLiquidityInfo(params: {
  provider: providers.Provider;
  chainId: ChainId;
  tokenId: string | number;
}): Promise<V3OnchainPositionLiquidityInfo> {
  const { provider, chainId } = params;
  const tokenId = typeof params.tokenId === 'string' ? params.tokenId : params.tokenId.toString();

  const positionManagerAddress = NONFUNGIBLE_POSITION_MANAGER_ADDRESSES[chainId];
  if (!positionManagerAddress) {
    throw new Error(`Unsupported chainId for V3 position manager: ${chainId}`);
  }

  const positionManager = new Contract(positionManagerAddress, NONFUNGIBLE_POSITION_MANAGER_ABI, provider);
  const pos = await positionManager.positions(tokenId);

  return {
    liquidity: pos.liquidity.toString(), tickLower: pos.tickLower.toString(), tickUpper: pos.tickUpper.toString()
  };
}

export async function fetchV3OnchainPositionInfo(params: {
  provider: providers.Provider;
  chainId: ChainId;
  poolAddress: string;
  tokenId: string | number;
  token0: Token;
  token1: Token;
  fee: number;
}): Promise<V3OnchainPositionInfo> {
  const [{ currentTick, currentPrice, currentLiquidity }, { liquidity, tickLower, tickUpper }] = await Promise.all([
    fetchV3OnchainPoolInfo({ provider: params.provider, poolAddress: params.poolAddress }),
    fetchV3OnchainPositionLiquidityInfo({
      provider: params.provider,
      chainId: params.chainId,
      tokenId: params.tokenId,
    }),
  ]);

  const pool = new Pool(
    params.token0,
    params.token1,
    params.fee,
    currentPrice,
    currentLiquidity,
    parseInt(currentTick)
  )

  const position = new Position({
    pool,
    tickLower: parseInt(tickLower),
    tickUpper: parseInt(tickUpper),
    liquidity: parseInt(liquidity),
  });

  return {
    liquidity,
    currentTick,
    currentPrice,
    currentLiquidity,
    tickLower,
    tickUpper,
    amount0: position.amount0.quotient.toString(),
    amount1: position.amount1.quotient.toString(),
  };
}

