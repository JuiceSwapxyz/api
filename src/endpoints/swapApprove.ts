import { Request, Response } from "express";
import { RouterService } from "../core/RouterService";
import { trackUser } from "../services/userTracking";
import { extractIpAddress } from "../utils/ipAddress";
import Logger from "bunyan";
import { getApproveTxForToken } from "../utils/erc20";
import { ethers } from "ethers";

interface SwapApproveRequestBody {
  walletAddress: string;
  spenderAddress: string;
  chainId: number;
  tokenIn: string;
}

/**
 * @swagger
 * /v1/swap/approve:
 *   post:
 *     tags: [Swap]
 *     summary: Approve tokens for Swap
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/SwapApproveRequest'
 *           example:
 *             walletAddress: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
 *             chainId: 5115
 *             protocol: "V3"
 *             token0: "0xFdB0a83d94CD65151148a131167Eb499Cb85d015"
 *             token1: "0x8d0c9d1c17aE5e40ffF9bE350f57840E9E66Cd93"
 *             amount0: "1000000000000000000"
 *             amount1: "1000000000000000000"
 *             simulateTransaction: false
 *     responses:
 *       200:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SwapApprovalResponse'
 *       default:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
export function createSwapApproveHandler(
  routerService: RouterService,
  logger: Logger,
) {
  return async function handleSwapApprove(
    req: Request,
    res: Response,
  ): Promise<void> {
    const log = logger.child({ endpoint: "swap_approve" });

    try {
      const {
        walletAddress,
        chainId,
        tokenIn,
        spenderAddress,
      }: SwapApproveRequestBody = req.body;

      trackUser(walletAddress, extractIpAddress(req), log);

      if (!walletAddress || !chainId || !tokenIn) {
        log.debug(
          { walletAddress, chainId, tokenIn },
          "Validation failed: missing required fields",
        );
        res.status(400).json({
          message: "Missing required fields",
          error: "MissingRequiredFields",
        });
        return;
      }

      const provider = routerService.getProvider(chainId);
      if (!provider) {
        log.debug(
          { chainId },
          "Validation failed: invalid chainId for Swap approve",
        );
        res.status(400).json({
          message: "Invalid chainId",
          error: "InvalidChainId",
        });
        return;
      }

      const tokenApproval = await getApproveTxForToken(
        tokenIn,
        ethers.constants.MaxUint256.toString(),
        walletAddress,
        spenderAddress,
        provider,
        chainId,
        log,
      );

      let gasEstimate = ethers.BigNumber.from("100000"); // Default gas estimate for approval
      try {
        gasEstimate = await provider.estimateGas({
          to: tokenIn,
          from: walletAddress,
          data: tokenApproval?.data,
        });
      } catch (e) {
        log.warn("Gas estimation failed, using fallback");
      }

      const gasLimit = gasEstimate.mul(110).div(100);

      // Use actual gas price from the provider for accurate estimation
      // EIP-1559 fee data can be inflated on some chains, so we prefer legacy gasPrice
      const gasPrice = await provider.getGasPrice();

      // Use legacy gas price with small buffer for maxFeePerGas
      // This is more accurate for low-gas chains like Citrea
      const maxFeePerGas = gasPrice.mul(120).div(100); // 20% buffer
      const maxPriorityFeePerGas = gasPrice.mul(10).div(100); // 10% of gas price

      // Calculate gas fee using actual gas price (not inflated EIP-1559 values)
      const gasFee = gasLimit.mul(gasPrice);

      log.info(
        {
          gasLimit: gasLimit.toString(),
          maxFeePerGas: maxFeePerGas.toString(),
          maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
          gasFee: gasFee.toString(),
        },
        "Approval gas calculation",
      );

      res.status(200).json({
        requestId: `swap-approve-${Date.now()}`,
        tokenApproval: {
          ...tokenApproval,
          maxFeePerGas: maxFeePerGas.toHexString(),
          maxPriorityFeePerGas: maxPriorityFeePerGas.toHexString(),
          gasLimit: gasLimit.toHexString(),
        },
        gasFee: gasFee.toString(),
      });

      log.debug({ chainId, walletAddress }, "Swap approve request completed");
    } catch (error: any) {
      log.error({ error }, "Error in handleSwapApprove");
      res.status(500).json({
        message: "Internal server error",
        error: error?.message,
      });
    }
  };
}
