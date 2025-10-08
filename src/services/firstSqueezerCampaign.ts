import { prisma } from '../db/prisma';
import Logger from 'bunyan';
import { ethers } from 'ethers';
import axios from 'axios';

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
  private ponderApiUrl: string;

  constructor(logger: Logger) {
    this.logger = logger;
    this.ponderApiUrl = process.env.PONDER_API_URL || 'https://ponder.juiceswap.com';
  }

  /**
   * Check if user has completed all 3 bApps campaign tasks via Ponder indexer
   * Returns completion status and the date of the last completed task
   */
  private async checkPonderBappsCompletion(
    walletAddress: string,
    chainId: number
  ): Promise<{ isCompleted: boolean; completedAt?: Date }> {
    try {
      const response = await axios.post(
        `${this.ponderApiUrl}/campaign/progress`,
        {
          walletAddress,
          chainId,
        },
        {
          headers: {
            'Content-Type': 'application/json',
          },
          timeout: 5000, // 5 second timeout
        }
      );

      const data = response.data;
      const isCompleted = data.completedTasks === 3;

      // Get the completion date from the last task (task 3)
      let completedAt: Date | undefined;
      if (isCompleted && data.tasks && data.tasks.length >= 3) {
        const lastTask = data.tasks.find((t: any) => t.id === 3);
        if (lastTask?.completedAt) {
          completedAt = new Date(lastTask.completedAt);
        }
      }

      this.logger.info(
        { walletAddress, completedTasks: data.completedTasks, isCompleted, completedAt },
        'Checked Ponder bApps completion'
      );

      return { isCompleted, completedAt };
    } catch (error) {
      this.logger.warn(
        { error, walletAddress },
        'Failed to check Ponder bApps completion - assuming not completed'
      );
      return { isCompleted: false };
    }
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
      let campaignData = await prisma.firstSqueezerCampaignUser.upsert({
        where: { userId: user.id },
        create: { userId: user.id },
        update: { updatedAt: new Date() },
      });

      // Check and sync bApps completion from Ponder if not already completed
      if (!campaignData.bappsCompleted) {
        const ponderResult = await this.checkPonderBappsCompletion(
          checksummedAddress,
          chainId
        );

        if (ponderResult.isCompleted) {
          // Update database with completion status and real completion date from Ponder
          campaignData = await prisma.firstSqueezerCampaignUser.update({
            where: { userId: user.id },
            data: {
              bappsCompleted: true,
              bappsCompletedAt: ponderResult.completedAt || new Date(),
              updatedAt: new Date(),
            },
          });

          this.logger.info(
            { walletAddress: checksummedAddress, completedAt: ponderResult.completedAt },
            'Synced bApps completion from Ponder to database'
          );
        }
      }

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

      // Check if this Twitter account is already used by another wallet
      const existingTwitterUser = await prisma.firstSqueezerCampaignUser.findUnique({
        where: { twitterUserId },
        include: { user: true },
      });

      if (existingTwitterUser && existingTwitterUser.user.address.toLowerCase() !== checksummedAddress.toLowerCase()) {
        throw new Error(`This Twitter account (@${twitterUsername}) is already verified with another wallet address`);
      }

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

      // Check if this Discord account is already used by another wallet
      const existingDiscordUser = await prisma.firstSqueezerCampaignUser.findUnique({
        where: { discordUserId },
        include: { user: true },
      });

      if (existingDiscordUser && existingDiscordUser.user.address.toLowerCase() !== checksummedAddress.toLowerCase()) {
        throw new Error(`This Discord account (${discordUsername}) is already verified with another wallet address`);
      }

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
