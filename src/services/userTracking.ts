import { ethers } from 'ethers';
import { prisma } from '../db/prisma';
import { hashIpAddress } from '../utils/ipAddress';
import Logger from 'bunyan';

/**
 * Tracks user wallet addresses and hashed IP addresses in the User table.
 * IP addresses are hashed using SHA-256 for privacy compliance.
 * Non-blocking: always resolves, never throws.
 */
export async function trackUser(
  address: string | undefined,
  ipAddress: string | undefined,
  logger: Logger
): Promise<void> {
  try {
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

    // Hash the IP address for privacy-preserving storage
    const ipAddressHash = hashIpAddress(ipAddress);

    // Only create if user doesn't exist, no updates needed
    await prisma.user.upsert({
      where: {
        address: checksummedAddress,
      },
      create: {
        address: checksummedAddress,
        ipAddressHash: ipAddressHash,
      },
      update: {},
    });

    logger.debug({ address: checksummedAddress, ipHashed: !!ipAddressHash }, 'User tracked successfully');
  } catch (error) {
    logger.warn(
      {
        address,
        ipAddress,
        error: error instanceof Error ? {
          message: error.message,
          name: error.name,
        } : error,
      },
      'Failed to track user (non-critical)'
    );
  }
}
