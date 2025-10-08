import { Request, Response } from 'express';
import { RouterService } from '../core/RouterService';
import Logger from 'bunyan';

enum SwapStatus {
  PENDING = 'PENDING',
  SUCCESS = 'SUCCESS',
  NOT_FOUND = 'NOT_FOUND',
  FAILED = 'FAILED',
  EXPIRED = 'EXPIRED',
}

interface GetSwapsResponse {
  requestId: string;
  swaps: Array<{
    swapType?: string;
    status?: SwapStatus;
    txHash?: string;
    swapId?: string;
  }>;
}

/**
 * @swagger
 * /v1/swaps:
 *   get:
 *     tags: [Swaps]
 *     summary: Check transaction status
 *     parameters:
 *       - in: query
 *         name: txHashes
 *         required: true
 *         schema:
 *           type: string
 *         example: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
 *       - in: query
 *         name: chainId
 *         required: true
 *         schema:
 *           type: integer
 *         example: 5115
 *     responses:
 *       200:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SwapStatus'
 *       default:
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
export function createSwapsHandler(routerService: RouterService, logger: Logger) {
  return async function handleSwaps(req: Request, res: Response): Promise<void> {
    const log = logger.child({ endpoint: 'swaps' });
    const { txHashes, chainId } = req.query;

    if (!txHashes || !chainId) {
      log.debug({ txHashes, chainId }, 'Validation failed: missing txHashes or chainId');
      res.status(400).json({ message: 'Missing txHashes or chainId' });
      return;
    }

    const txHashesArray = txHashes.toString().split(',');
    if (txHashesArray.length === 0) {
      log.debug({ txHashes }, 'Validation failed: invalid txHashes (empty array)');
      res.status(400).json({ message: 'Invalid txHashes' });
      return;
    }

    try {
      const chainIdNumber = parseInt(chainId.toString());
      const provider = routerService.getProvider(chainIdNumber);

      if (!provider) {
        res.status(400).json({ message: `No RPC provider available for chainId ${chainId}` });
        return;
      }

      const swapPromises = txHashesArray.map(async (txHash: string) => {
        try {
          const receipt = await provider.getTransactionReceipt(txHash.trim());

          if (!receipt) {
            return {
              txHash: txHash.trim(),
              status: SwapStatus.NOT_FOUND
            };
          }

          if (receipt.status === 1) {
            return {
              txHash: txHash.trim(),
              status: SwapStatus.SUCCESS
            };
          } else if (receipt.status === 0) {
            return {
              txHash: txHash.trim(),
              status: SwapStatus.FAILED
            };
          } else {
            return {
              txHash: txHash.trim(),
              status: SwapStatus.PENDING
            };
          }
        } catch (error: any) {
          log.error({ error, txHash }, `Error checking transaction status for ${txHash}`);

          return {
            txHash: txHash.trim(),
            status: SwapStatus.NOT_FOUND,
          };
        }
      });

      const swapResults = await Promise.all(swapPromises);

      const swaps: GetSwapsResponse = {
        requestId: Math.random().toString(36).substring(2, 15),
        swaps: swapResults.map(swap => ({
          swapType: 'CLASSIC',
          swapId: swap.txHash,
          ...swap
        }))
      };

      // Log summary of transaction status checks
      const statusCounts = swapResults.reduce((acc, swap) => {
        acc[swap.status] = (acc[swap.status] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      log.debug({
        txCount: txHashesArray.length,
        statusCounts,
      }, 'Transaction status check completed');

      res.status(200).json(swaps);
    } catch (error: any) {
      log.error({ error }, 'Error in handleSwaps');
      res.status(500).json({ message: 'Internal server error' });
    }
  };
}
