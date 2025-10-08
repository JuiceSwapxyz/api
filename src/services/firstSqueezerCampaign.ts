import { prisma } from '../db/prisma';
import Logger from 'bunyan';
import { ethers } from 'ethers';

export interface CampaignProgress {
  walletAddress: string;
  chainId: number;
  conditions: CampaignCondition[];
  totalConditions: number;
  completedConditions: number;
  progress: number; // 0-100
  isEligibleForNFT: boolean;
  nftMinted: boolean;
  nftTokenId?: string;
  nftTxHash?: string;
  nftMintedAt?: string;
}

export interface CampaignCondition {
  id: number;
  type: 'bapps_completed' | 'twitter_follow' | 'discord_join';
  name: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  completedAt?: string;
  ctaText?: string;
  ctaUrl?: string;
  icon?: string;
}

export class FirstSqueezerCampaignService {
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Get or create campaign progress for a wallet
   */
  async getProgress(
    walletAddress: string,
    chainId: number
  ): Promise<CampaignProgress> {
    try {
      const checksummedAddress = ethers.utils.getAddress(walletAddress);

      // Get or create user
      const user = await prisma.user.upsert({
        where: { address: checksummedAddress },
        create: { address: checksummedAddress },
        update: { updatedAt: new Date() },
      });

      // Get or create campaign progress
      const campaignData = await prisma.firstSqueezerCampaignUser.upsert({
        where: { userId: user.id },
        create: { userId: user.id },
        update: { updatedAt: new Date() },
      });

      // Build conditions array
      const conditions: CampaignCondition[] = [
        {
          id: 1,
          type: 'bapps_completed',
          name: 'Complete ₿apps Campaign',
          description: 'Complete all 3 swap tasks in the Citrea ₿apps Campaign',
          status: campaignData.bappsCompleted ? 'completed' : 'pending',
          completedAt: campaignData.bappsCompletedAt?.toISOString(),
          ctaText: 'View Campaign',
          ctaUrl: '/bapps',
        },
        {
          id: 2,
          type: 'twitter_follow',
          name: 'Follow JuiceSwap on X',
          description: 'Follow @JuiceSwap_com on X (Twitter)',
          status: campaignData.twitterVerifiedAt ? 'completed' : 'pending',
          completedAt: campaignData.twitterVerifiedAt?.toISOString(),
          ctaText: 'Follow on X',
          ctaUrl: 'https://x.com/JuiceSwap_com',
          icon: '🐦',
        },
        {
          id: 3,
          type: 'discord_join',
          name: 'Join JuiceSwap Discord',
          description: 'Join the JuiceSwap Discord community',
          status: campaignData.discordVerifiedAt ? 'completed' : 'pending',
          completedAt: campaignData.discordVerifiedAt?.toISOString(),
          ctaText: 'Join Discord',
          ctaUrl: 'https://discord.gg/juiceswap',
          icon: '💬',
        },
      ];

      const completedConditions = conditions.filter(
        (c) => c.status === 'completed'
      ).length;
      const progress = (completedConditions / conditions.length) * 100;
      const isEligibleForNFT =
        completedConditions === conditions.length && !campaignData.nftMinted;

      return {
        walletAddress: checksummedAddress,
        chainId,
        conditions,
        totalConditions: conditions.length,
        completedConditions,
        progress,
        isEligibleForNFT,
        nftMinted: campaignData.nftMinted,
        nftTokenId: campaignData.nftTokenId || undefined,
        nftTxHash: campaignData.nftTxHash || undefined,
        nftMintedAt: campaignData.nftMintedAt?.toISOString(),
      };
    } catch (error) {
      this.logger.error({ error, walletAddress }, 'Failed to get campaign progress');
      throw new Error('Failed to fetch campaign progress');
    }
  }

  /**
   * Mark Twitter follow as verified
   */
  async verifyTwitterFollow(
    walletAddress: string,
    twitterUserId: string,
    twitterUsername: string
  ): Promise<void> {
    try {
      const checksummedAddress = ethers.utils.getAddress(walletAddress);

      // Get or create user
      const user = await prisma.user.upsert({
        where: { address: checksummedAddress },
        create: { address: checksummedAddress },
        update: { updatedAt: new Date() },
      });

      // Update campaign data
      await prisma.firstSqueezerCampaignUser.upsert({
        where: { userId: user.id },
        create: {
          userId: user.id,
          twitterVerifiedAt: new Date(),
          twitterUserId,
          twitterUsername,
        },
        update: {
          twitterVerifiedAt: new Date(),
          twitterUserId,
          twitterUsername,
          updatedAt: new Date(),
        },
      });

      this.logger.info(
        { walletAddress, twitterUserId, twitterUsername },
        'Twitter follow verified'
      );
    } catch (error) {
      this.logger.error(
        { error, walletAddress, twitterUserId },
        'Failed to verify Twitter follow'
      );
      throw new Error('Failed to verify Twitter follow');
    }
  }

  /**
   * Mark Discord join as verified
   */
  async verifyDiscordJoin(
    walletAddress: string,
    discordUserId: string,
    discordUsername: string
  ): Promise<void> {
    try {
      const checksummedAddress = ethers.utils.getAddress(walletAddress);

      // Get or create user
      const user = await prisma.user.upsert({
        where: { address: checksummedAddress },
        create: { address: checksummedAddress },
        update: { updatedAt: new Date() },
      });

      // Update campaign data
      await prisma.firstSqueezerCampaignUser.upsert({
        where: { userId: user.id },
        create: {
          userId: user.id,
          discordVerifiedAt: new Date(),
          discordUserId,
          discordUsername,
        },
        update: {
          discordVerifiedAt: new Date(),
          discordUserId,
          discordUsername,
          updatedAt: new Date(),
        },
      });

      this.logger.info(
        { walletAddress, discordUserId, discordUsername },
        'Discord join verified'
      );
    } catch (error) {
      this.logger.error(
        { error, walletAddress, discordUserId },
        'Failed to verify Discord join'
      );
      throw new Error('Failed to verify Discord join');
    }
  }

  /**
   * Mark ₿apps campaign as completed
   */
  async markBappsCompleted(walletAddress: string): Promise<void> {
    try {
      const checksummedAddress = ethers.utils.getAddress(walletAddress);

      // Get or create user
      const user = await prisma.user.upsert({
        where: { address: checksummedAddress },
        create: { address: checksummedAddress },
        update: { updatedAt: new Date() },
      });

      // Update campaign data
      await prisma.firstSqueezerCampaignUser.upsert({
        where: { userId: user.id },
        create: {
          userId: user.id,
          bappsCompleted: true,
          bappsCompletedAt: new Date(),
        },
        update: {
          bappsCompleted: true,
          bappsCompletedAt: new Date(),
          updatedAt: new Date(),
        },
      });

      this.logger.info({ walletAddress }, '₿apps campaign marked as completed');
    } catch (error) {
      this.logger.error(
        { error, walletAddress },
        'Failed to mark ₿apps as completed'
      );
      throw new Error('Failed to mark ₿apps campaign as completed');
    }
  }

  /**
   * Record NFT mint
   */
  async recordNFTMint(
    walletAddress: string,
    txHash: string,
    tokenId: string
  ): Promise<void> {
    try {
      const checksummedAddress = ethers.utils.getAddress(walletAddress);

      // Get user
      const user = await prisma.user.findUnique({
        where: { address: checksummedAddress },
      });

      if (!user) {
        throw new Error('User not found');
      }

      // Update campaign data
      await prisma.firstSqueezerCampaignUser.update({
        where: { userId: user.id },
        data: {
          nftMinted: true,
          nftMintedAt: new Date(),
          nftTxHash: txHash,
          nftTokenId: tokenId,
          updatedAt: new Date(),
        },
      });

      this.logger.info(
        { walletAddress, txHash, tokenId },
        'NFT mint recorded'
      );
    } catch (error) {
      this.logger.error(
        { error, walletAddress, txHash },
        'Failed to record NFT mint'
      );
      throw new Error('Failed to record NFT mint');
    }
  }

  /**
   * Check if user is eligible for NFT (all conditions completed)
   */
  async isEligibleForNFT(walletAddress: string): Promise<boolean> {
    try {
      const checksummedAddress = ethers.utils.getAddress(walletAddress);

      const user = await prisma.user.findUnique({
        where: { address: checksummedAddress },
        include: {
          firstSqueezerCampaign: true,
        },
      });

      if (!user || !user.firstSqueezerCampaign) {
        return false;
      }

      const campaign = user.firstSqueezerCampaign;

      // Check all conditions
      const allCompleted =
        campaign.bappsCompleted &&
        campaign.twitterVerifiedAt !== null &&
        campaign.discordVerifiedAt !== null;

      // Not already minted
      const notMinted = !campaign.nftMinted;

      return allCompleted && notMinted;
    } catch (error) {
      this.logger.error({ error, walletAddress }, 'Failed to check NFT eligibility');
      return false;
    }
  }
}
