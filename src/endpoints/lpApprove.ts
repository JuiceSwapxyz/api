import { Request, Response } from 'express';
import { RouterService } from '../core/RouterService';
import { trackUser } from '../services/userTracking';
import { extractIpAddress } from '../utils/ipAddress';
import Logger from 'bunyan';
import { getApproveTxForToken } from '../utils/erc20';
import { NONFUNGIBLE_POSITION_MANAGER_ADDRESSES } from '@juiceswapxyz/sdk-core';
import { JuiceGatewayService } from '../services/JuiceGatewayService';
import { hasJuiceDollarIntegration } from '../config/contracts';

interface LpApproveRequestBody {
  simulateTransaction: boolean;
  walletAddress: string;
  chainId: number;
  protocol: string;
  token0: string;
  token1: string;
  amount0: string;
  amount1: string;
}

/**
 * @swagger
 * /v1/lp/approve:
 *   post:
 *     tags: [Liquidity]
 *     summary: Approve tokens for LP
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/LpApproveRequest'
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
 *               $ref: '#/components/schemas/LpApprovalResponse'
 *       default:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
export function createLpApproveHandler(
  routerService: RouterService,
  logger: Logger,
  juiceGatewayService?: JuiceGatewayService
) {
  return async function handleLpApprove(req: Request, res: Response): Promise<void> {
    const log = logger.child({ endpoint: 'lp_approve' });

    try {
      const { walletAddress, chainId, token0, token1, amount0, amount1 }: LpApproveRequestBody = req.body;

      trackUser(walletAddress, extractIpAddress(req), log);

      if (!walletAddress || !chainId || !token0 || !token1 || !amount0 || !amount1) {
        log.debug({ walletAddress, chainId, token0, token1, amount0, amount1 }, 'Validation failed: missing required fields');
        res.status(400).json({
          message: 'Missing required fields',
          error: 'MissingRequiredFields'
        });
        return;
      }

      const provider = routerService.getProvider(chainId);
      if (!provider) {
        log.debug({ chainId }, 'Validation failed: invalid chainId for LP approve');
        res.status(400).json({
          message: 'Invalid chainId',
          error: 'InvalidChainId'
        });
        return;
      }

      // Determine spender based on whether JUSD is involved
      // If JUSD is involved, route through Gateway for automatic svJUSD conversion
      let spender = NONFUNGIBLE_POSITION_MANAGER_ADDRESSES[chainId];
      let routingType: 'POSITION_MANAGER' | 'GATEWAY' = 'POSITION_MANAGER';

      if (
        juiceGatewayService &&
        hasJuiceDollarIntegration(chainId) &&
        juiceGatewayService.detectLpGatewayRouting(chainId, token0, token1)
      ) {
        const gatewayAddress = juiceGatewayService.getGatewayAddress(chainId);
        if (gatewayAddress) {
          spender = gatewayAddress;
          routingType = 'GATEWAY';
          log.debug({ chainId, token0, token1 }, 'LP approval routed through Gateway for JUSD');
        }
      }

      if (!spender) {
        res.status(400).json({
          message: 'Unsupported chain for LP operations',
          error: 'UnsupportedChain'
        });
        return;
      }

      const [token0Approval, token1Approval] = await Promise.all([
        getApproveTxForToken(token0, amount0, walletAddress, spender, provider, chainId, log),
        getApproveTxForToken(token1, amount1, walletAddress, spender, provider, chainId, log)
      ]);

      res.status(200).json({
        requestId: `lp-approve-${Date.now()}`,
        token0Approval,
        token1Approval,
        token0Cancel: null,
        token1Cancel: null,
        positionTokenApproval: null,
        permitData: null,
        token0PermitTransaction: null,
        token1PermitTransaction: null,
        positionTokenPermitTransaction: null,
        gasFeeToken0Approval: token0Approval?.gasLimit || '0',
        gasFeeToken1Approval: token1Approval?.gasLimit || '0',
        _spender: spender,
        _routingType: routingType,
      });

      log.debug({ chainId, walletAddress, routingType }, 'LP approve request completed');

    } catch (error: any) {
      log.error({ error }, 'Error in handleLpApprove');
      res.status(500).json({
        message: 'Internal server error',
        error: error?.message
      });
    }
  };
}
