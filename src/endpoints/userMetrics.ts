import { Request, Response } from 'express';
import Logger from 'bunyan';
import { prisma } from '../db/prisma';

/**
 * @swagger
 * /v1/metrics/users/total-with-ip:
 *   get:
 *     tags: [Metrics]
 *     summary: Get total count of user addresses with IP address hash
 *     description: Returns the total number of user wallet addresses that have an associated IP address hash
 *     responses:
 *       200:
 *         description: Total addresses with IP hash
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 totalAddressesWithIpHash:
 *                   type: number
 *                   description: Number of wallet addresses with IP hash stored
 *                   example: 1234
 *       500:
 *         description: Internal server error
 */
export function createTotalAddressesWithIpHandler(logger: Logger) {
  return async function handleTotalAddressesWithIp(_req: Request, res: Response): Promise<void> {
    const startTime = Date.now();

    try {
      const count = await prisma.user.count({
        where: {
          ipAddressHash: {
            not: null,
          },
        },
      });

      logger.debug({ count, responseTime: Date.now() - startTime }, 'Total addresses with IP hash retrieved');

      res.json({
        totalAddressesWithIpHash: count,
      });
    } catch (error) {
      logger.error({
        error: error instanceof Error ? {
          message: error.message,
          stack: error.stack,
          name: error.name,
        } : error,
      }, 'Failed to fetch total addresses with IP hash');

      res.status(500).json({
        error: 'Internal server error',
        detail: error instanceof Error ? error.message : 'Unknown error occurred',
      });
    }
  };
}

/**
 * @swagger
 * /v1/metrics/users/unique-ips:
 *   get:
 *     tags: [Metrics]
 *     summary: Get count of unique IP address hashes
 *     description: Returns the number of unique IP address hashes in the system. This helps identify how many unique network sources have interacted with the platform.
 *     responses:
 *       200:
 *         description: Unique IP hash count
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 uniqueIpHashes:
 *                   type: number
 *                   description: Number of unique IP address hashes
 *                   example: 987
 *       500:
 *         description: Internal server error
 */
export function createUniqueIpHashesHandler(logger: Logger) {
  return async function handleUniqueIpHashes(_req: Request, res: Response): Promise<void> {
    const startTime = Date.now();

    try {
      // Use Prisma's aggregation to count distinct IP hashes
      const result = await prisma.user.groupBy({
        by: ['ipAddressHash'],
        where: {
          ipAddressHash: {
            not: null,
          },
        },
        _count: true,
      });

      const uniqueCount = result.length;

      logger.debug({ uniqueCount, responseTime: Date.now() - startTime }, 'Unique IP hashes retrieved');

      res.json({
        uniqueIpHashes: uniqueCount,
      });
    } catch (error) {
      logger.error({
        error: error instanceof Error ? {
          message: error.message,
          stack: error.stack,
          name: error.name,
        } : error,
      }, 'Failed to fetch unique IP hashes');

      res.status(500).json({
        error: 'Internal server error',
        detail: error instanceof Error ? error.message : 'Unknown error occurred',
      });
    }
  };
}
