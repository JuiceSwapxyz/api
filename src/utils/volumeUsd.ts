import { ethers } from "ethers";

/**
 * Compute the USD value of a volume bucket by picking whichever token has a price.
 * Prefers token0; falls back to token1 if token0 has no price.
 */
export function computeVolumeUsd(
  rawVol0: string,
  rawVol1: string,
  decimals0: number,
  decimals1: number,
  price0: number,
  price1: number,
): number {
  if (price0 > 0) {
    return (
      parseFloat(ethers.utils.formatUnits(rawVol0 || "0", decimals0)) * price0
    );
  }
  if (price1 > 0) {
    return (
      parseFloat(ethers.utils.formatUnits(rawVol1 || "0", decimals1)) * price1
    );
  }
  return 0;
}
