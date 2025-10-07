import { ethers } from 'ethers';
import { prisma } from '../db/prisma';
import Logger from 'bunyan';

/**
 * Tracks user wallet addresses in the User table.
 * Non-blocking: always resolves, never throws.
 */
export async function trackUser(
  address: string | undefined,
  logger: Logger
): Promise<void> {
  try {
    if (process.env.OG_CAMPAIGN_ENABLED !== 'true') {
      return;
    }

    if (!address) {
      return;
    }

    let checksummedAddress: string;
    try {
      checksummedAddress = ethers.utils.getAddress(address);
    } catch (error) {
      logger.debug({ address, error }, 'Invalid address format for user tracking');
      return;
    }

    await prisma.user.upsert({
      where: {
        address: checksummedAddress,
      },
      create: {
        address: checksummedAddress,
      },
      update: {
        updatedAt: new Date(),
      },
    });

    logger.debug({ address: checksummedAddress }, 'User tracked successfully');
  } catch (error) {
    logger.warn(
      {
        address,
        error: error instanceof Error ? {
          message: error.message,
          name: error.name,
        } : error,
      },
      'Failed to track user (non-critical)'
    );
  }
}
