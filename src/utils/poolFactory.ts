import { computePoolAddress, Pool } from "@juiceswapxyz/v3-sdk";
import { CHAIN_TO_ADDRESSES_MAP, Token } from "@juiceswapxyz/sdk-core";
import { ethers } from "ethers";
import Logger from "bunyan";

const getPoolInstanceFromOnchainData = async (
  token0: Token,
  token1: Token,
  fee: number,
  chainId: number,
  provider: any,
  log?: Logger,
) => {
  try {
    // Calculate pool address
    const chainAddresses =
      CHAIN_TO_ADDRESSES_MAP[chainId as keyof typeof CHAIN_TO_ADDRESSES_MAP];
    if (!chainAddresses?.v3CoreFactoryAddress) {
      log?.warn({ chainId }, "No v3CoreFactoryAddress configured for chain");
      return null;
    }

    const poolAddress = computePoolAddress({
      factoryAddress: chainAddresses.v3CoreFactoryAddress,
      tokenA: token0,
      tokenB: token1,
      fee: fee,
      chainId: chainId,
    });

    log?.debug(
      {
        poolAddress,
        token0: token0.address,
        token1: token1.address,
        fee,
        chainId,
        factory: chainAddresses.v3CoreFactoryAddress,
      },
      "Computed pool address for on-chain lookup",
    );

    const poolContract = new ethers.Contract(
      poolAddress,
      [
        "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
      ],
      provider,
    );

    const slot0 = await poolContract.slot0();
    const currentSqrtPriceX96 = slot0.sqrtPriceX96;
    const currentTick = slot0.tick;

    log?.debug(
      {
        poolAddress,
        tick: currentTick,
        sqrtPriceX96: currentSqrtPriceX96.toString(),
      },
      "Successfully fetched on-chain pool data",
    );

    return new Pool(
      token0,
      token1,
      fee,
      currentSqrtPriceX96.toString(),
      "0",
      currentTick,
    );
  } catch (e: any) {
    log?.error(
      {
        error: e.message,
        stack: e.stack,
        chainId,
        token0: token0.address,
        token1: token1.address,
        fee,
      },
      "Failed to fetch pool instance from on-chain data",
    );
    return null;
  }
};

export type GetPoolInstanceParams = {
  token0: Token;
  token1: Token;
  fee: number;
  provider: any;
  chainId: number;
  sqrtPriceX96?: string;
  liquidity?: string;
  tickCurrent?: number;
  log?: Logger;
};

export const getPoolInstance = ({
  token0,
  token1,
  fee,
  chainId,
  sqrtPriceX96,
  liquidity = "0",
  tickCurrent,
  provider,
  log,
}: GetPoolInstanceParams) => {
  if (
    token0 &&
    token1 &&
    fee &&
    sqrtPriceX96 !== undefined &&
    liquidity !== undefined &&
    tickCurrent !== undefined
  ) {
    return new Pool(token0, token1, fee, sqrtPriceX96, liquidity, tickCurrent);
  }

  return getPoolInstanceFromOnchainData(
    token0,
    token1,
    fee,
    chainId,
    provider,
    log,
  );
};
