import { Request, Response } from 'express';
import { RouterService } from '../core/RouterService';
import { trackUser } from '../services/userTracking';
import { extractIpAddress } from '../utils/ipAddress';
import Logger from 'bunyan';
import { getApproveTxForToken } from '../utils/erc20';
import { ethers } from 'ethers';

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
export function createSwapApproveHandler(routerService: RouterService, logger: Logger) {
  return async function handleSwapApprove(req: Request, res: Response): Promise<void> {
    const log = logger.child({ endpoint: 'swap_approve' });

    try {
      const { walletAddress, chainId, tokenIn, spenderAddress }: SwapApproveRequestBody = req.body;

      trackUser(walletAddress, extractIpAddress(req), log);

      if (!walletAddress || !chainId || !tokenIn) {
        log.debug({ walletAddress, chainId, tokenIn }, 'Validation failed: missing required fields');
        res.status(400).json({
          message: 'Missing required fields',
          error: 'MissingRequiredFields'
        });
        return;
      }

      const provider = routerService.getProvider(chainId);
      if (!provider) {
        log.debug({ chainId }, 'Validation failed: invalid chainId for Swap approve');
        res.status(400).json({
          message: 'Invalid chainId',
          error: 'InvalidChainId'
        });
        return;
      }


      const tokenApproval = await getApproveTxForToken(tokenIn, ethers.constants.MaxUint256.toString(), walletAddress, spenderAddress, provider, chainId, log)

      // Get fee data for gas estimation
      const feeData = await provider.getFeeData();
      
      let gasEstimate = ethers.BigNumber.from('100000'); // Default gas estimate for approval
      try {
        gasEstimate = await provider.estimateGas({
          to: tokenIn,
          from: walletAddress,
          data: tokenApproval?.data,
        });
      } catch (e) {
        log.warn('Gas estimation failed, using fallback');
      }

      const gasLimit = gasEstimate.mul(110).div(100);

      const baseFee = feeData.lastBaseFeePerGas || ethers.utils.parseUnits('0.00000136', 'gwei');
      const maxPriorityFeePerGas = ethers.utils.parseUnits('1', 'gwei');
      const maxFeePerGas = baseFee.mul(105).div(100).add(maxPriorityFeePerGas);

      const gasFee = gasLimit.mul(maxFeePerGas);

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

      log.debug({ chainId, walletAddress }, 'Swap approve request completed');

    } catch (error: any) {
      log.error({ error }, 'Error in handleSwapApprove');
      res.status(500).json({
        message: 'Internal server error',
        error: error?.message
      });
    }
  };
}
