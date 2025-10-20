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

    // Use PostgreSQL INSERT ... ON CONFLICT to handle upsert in a single query
    // This avoids race conditions and is more efficient than separate queries
    await prisma.$executeRaw`
      INSERT INTO "User" (id, address, "ipAddressHash", "createdAt", "updatedAt")
      VALUES (gen_random_uuid(), ${checksummedAddress}, ${ipAddressHash}, NOW(), NOW())
      ON CONFLICT (address)
      DO UPDATE SET
        "ipAddressHash" = COALESCE("User"."ipAddressHash", EXCLUDED."ipAddressHash"),
        "updatedAt" = NOW()
      WHERE "User"."ipAddressHash" IS NULL
    `

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
