import { Request, Response } from 'express';
import Logger from 'bunyan';
import { prisma } from '../db/prisma';
import axios from 'axios';

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

/**
 * @swagger
 * /v1/metrics/fistSqueezer:
 *   get:
 *     tags: [Metrics]
 *     summary: Get count of NFTs minted by addresses with IP hash
 *     description: Returns the number of NFTs that were claimed by wallet addresses that have an associated IP address hash. Cross-references the Ponder indexer NFT claims with the User database. Includes unique IP hash count to identify distinct network sources.
 *     responses:
 *       200:
 *         description: NFT claim statistics for addresses with IP hash
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 totalNftsClaimed:
 *                   type: number
 *                   description: Total number of NFTs claimed across all addresses
 *                   example: 4192
 *                 totalAddressesWithIpHash:
 *                   type: number
 *                   description: Total number of addresses with IP hash in database
 *                   example: 12049
 *                 nftsClaimedByAddressesWithIpHash:
 *                   type: number
 *                   description: Number of NFTs claimed by addresses that have an IP hash
 *                   example: 3456
 *                 addressesWithIpHashThatClaimedNft:
 *                   type: number
 *                   description: Number of unique addresses (with IP hash) that claimed at least one NFT
 *                   example: 3456
 *                 uniqueIpHashesThatClaimedNft:
 *                   type: number
 *                   description: Number of unique IP address hashes that claimed at least one NFT (multiple addresses can share the same IP hash)
 *                   example: 2890
 *                 percentage:
 *                   type: number
 *                   description: Percentage of NFTs claimed by addresses with IP hash
 *                   example: 82.45
 *       500:
 *         description: Internal server error
 */
export function createFistSqueezerHandler(logger: Logger) {
  return async function handleFistSqueezer(_req: Request, res: Response): Promise<void> {
    const startTime = Date.now();

    try {
      // Get all addresses with IP hash from our database
      const usersWithIpHash = await prisma.user.findMany({
        where: {
          ipAddressHash: {
            not: null,
          },
        },
        select: {
          address: true,
          ipAddressHash: true,
        },
      });

      const addressesWithIpHashSet = new Set(
        usersWithIpHash.map(u => u.address.toLowerCase())
      );

      // Map addresses to their IP hash for unique IP counting
      const addressToIpHash = new Map(
        usersWithIpHash.map(u => [u.address.toLowerCase(), u.ipAddressHash!])
      );

      logger.debug(
        { addressesWithIpHashCount: addressesWithIpHashSet.size },
        'Addresses with IP hash loaded'
      );

      // Fetch all NFT claims from Ponder GraphQL endpoint
      const ponderUrl = process.env.PONDER_URL || 'https://ponder.juiceswap.com/graphql';
      let allNftClaims: Array<{ walletAddress: string }> = [];
      let hasMore = true;
      let after: string | null = null;

      while (hasMore) {
        const query: string = after
          ? `{ nftClaims(limit: 1000, after: "${after}") { items { walletAddress } pageInfo { hasNextPage endCursor } } }`
          : `{ nftClaims(limit: 1000) { items { walletAddress } pageInfo { hasNextPage endCursor } } }`;

        const response: any = await axios.post(ponderUrl, {
          query,
        });

        if (response.data.errors) {
          throw new Error(`GraphQL error: ${JSON.stringify(response.data.errors)}`);
        }

        const claims: Array<{ walletAddress: string }> = response.data.data.nftClaims.items;
        const pageInfo: any = response.data.data.nftClaims.pageInfo;

        allNftClaims.push(...claims);

        hasMore = pageInfo?.hasNextPage || false;
        after = pageInfo?.endCursor || null;

        logger.debug(
          {
            batchSize: claims.length,
            totalClaims: allNftClaims.length,
            hasMore,
            after
          },
          'Fetched NFT claims batch'
        );
      }

      logger.debug({ totalNftClaims: allNftClaims.length }, 'All NFT claims loaded from Ponder');

      // Count NFTs claimed by addresses with IP hash
      let nftsClaimedByAddressesWithIpHash = 0;
      const uniqueAddressesThatClaimed = new Set<string>();
      const uniqueIpHashesThatClaimedNft = new Set<string>();

      for (const claim of allNftClaims) {
        const normalizedAddress = claim.walletAddress.toLowerCase();
        if (addressesWithIpHashSet.has(normalizedAddress)) {
          nftsClaimedByAddressesWithIpHash++;
          uniqueAddressesThatClaimed.add(normalizedAddress);

          // Track unique IP hashes
          const ipHash = addressToIpHash.get(normalizedAddress);
          if (ipHash) {
            uniqueIpHashesThatClaimedNft.add(ipHash);
          }
        }
      }

      const percentage = allNftClaims.length > 0
        ? (nftsClaimedByAddressesWithIpHash / allNftClaims.length) * 100
        : 0;

      const result = {
        totalNftsClaimed: allNftClaims.length,
        totalAddressesWithIpHash: addressesWithIpHashSet.size,
        nftsClaimedByAddressesWithIpHash,
        addressesWithIpHashThatClaimedNft: uniqueAddressesThatClaimed.size,
        uniqueIpHashesThatClaimedNft: uniqueIpHashesThatClaimedNft.size,
        percentage: Number(percentage.toFixed(2)),
      };

      logger.info(
        {
          ...result,
          responseTime: Date.now() - startTime
        },
        'FistSqueezer metrics calculated'
      );

      res.json(result);
    } catch (error) {
      logger.error({
        error: error instanceof Error ? {
          message: error.message,
          stack: error.stack,
          name: error.name,
        } : error,
      }, 'Failed to fetch fistSqueezer metrics');

      res.status(500).json({
        error: 'Internal server error',
        detail: error instanceof Error ? error.message : 'Unknown error occurred',
      });
    }
  };
}
