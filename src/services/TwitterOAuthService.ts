import { OAuth } from 'oauth';
import { prisma } from '../db/prisma';

/**
 * Twitter OAuth 1.0a Service
 * Handles Twitter authentication flow for friendship verification
 * Uses database for persistent session storage (production-ready)
 */

interface TwitterOAuthConfig {
  consumerKey: string;
  consumerSecret: string;
  callbackUrl: string;
}

interface TwitterUserData {
  id: string;
  name: string;
  username: string;
}

interface FriendshipData {
  relationship: {
    source: {
      screen_name: string;
      following: boolean;
      followed_by: boolean;
    };
    target: {
      screen_name: string;
    };
  };
}

export class TwitterOAuthService {
  private cleanupIntervalId: NodeJS.Timeout | null = null;
  private readonly oauth: OAuth;

  // OAuth URLs
  private readonly REQUEST_TOKEN_URL = 'https://api.twitter.com/oauth/request_token';
  private readonly ACCESS_TOKEN_URL = 'https://api.twitter.com/oauth/access_token';
  private readonly AUTHORIZE_URL = 'https://api.twitter.com/oauth/authorize';

  // API URLs
  private readonly VERIFY_CREDENTIALS_URL = 'https://api.twitter.com/1.1/account/verify_credentials.json';
  private readonly FRIENDSHIPS_SHOW_URL = 'https://api.twitter.com/1.1/friendships/show.json';

  // Session expiry time (10 minutes)
  private readonly SESSION_EXPIRY_MS = 10 * 60 * 1000;

  constructor(config: TwitterOAuthConfig) {
    // Initialize OAuth 1.0a client
    this.oauth = new OAuth(
      this.REQUEST_TOKEN_URL,
      this.ACCESS_TOKEN_URL,
      config.consumerKey,
      config.consumerSecret,
      '1.0A',
      config.callbackUrl,
      'HMAC-SHA1'
    );

    // Clean up expired sessions every 5 minutes
    this.cleanupIntervalId = setInterval(() => this.cleanupSessions(), 5 * 60 * 1000);
  }

  /**
   * Stop the cleanup interval (call on app shutdown)
   */
  public destroy(): void {
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = null;
    }
  }

  /**
   * Generate authorization URL for user to visit
   * Stores session in database for persistence across restarts
   */
  public async generateAuthUrl(walletAddress: string): Promise<{ authUrl: string; requestToken: string }> {
    return new Promise((resolve, reject) => {
      // Get OAuth request token
      this.oauth.getOAuthRequestToken(async (error, oauthToken, oauthTokenSecret) => {
        if (error) {
          reject(new Error(`Failed to get request token: ${JSON.stringify(error)}`));
          return;
        }

        try {
          // Calculate expiry time (10 minutes from now)
          const expiresAt = new Date(Date.now() + this.SESSION_EXPIRY_MS);

          // Store session in database
          await prisma.twitterOAuthSession.create({
            data: {
              oauthToken,
              oauthTokenSecret,
              walletAddress,
              expiresAt,
            },
          });

          // Build authorization URL
          const authUrl = `${this.AUTHORIZE_URL}?oauth_token=${oauthToken}`;

          resolve({ authUrl, requestToken: oauthToken });
        } catch (dbError) {
          reject(new Error(`Failed to store session: ${dbError}`));
        }
      });
    });
  }

  /**
   * Exchange OAuth verifier for access token
   * Retrieves and validates session from database
   */
  public async getAccessToken(
    oauthToken: string,
    oauthVerifier: string
  ): Promise<{ accessToken: string; accessTokenSecret: string; walletAddress: string }> {
    // Retrieve session from database
    const session = await prisma.twitterOAuthSession.findUnique({
      where: { oauthToken },
    });

    if (!session) {
      throw new Error('Invalid or expired OAuth token');
    }

    // Check if session has expired
    if (session.expiresAt < new Date()) {
      // Delete expired session
      await prisma.twitterOAuthSession.delete({ where: { oauthToken } });
      throw new Error('Session has expired. Please try again.');
    }

    return new Promise((resolve, reject) => {
      this.oauth.getOAuthAccessToken(
        oauthToken,
        session.oauthTokenSecret,
        oauthVerifier,
        async (error, accessToken, accessTokenSecret) => {
          if (error) {
            // Clean up session on error
            await prisma.twitterOAuthSession.delete({ where: { oauthToken } }).catch(() => {});
            reject(new Error(`Failed to get access token: ${JSON.stringify(error)}`));
            return;
          }

          // Clean up session from database (consumed)
          await prisma.twitterOAuthSession.delete({ where: { oauthToken } }).catch(() => {});

          resolve({
            accessToken,
            accessTokenSecret,
            walletAddress: session.walletAddress,
          });
        }
      );
    });
  }

  /**
   * Get authenticated user's Twitter profile
   */
  public async getUserInfo(accessToken: string, accessTokenSecret: string): Promise<TwitterUserData> {
    return new Promise((resolve, reject) => {
      this.oauth.get(
        this.VERIFY_CREDENTIALS_URL,
        accessToken,
        accessTokenSecret,
        (error, data) => {
          if (error) {
            reject(new Error(`Failed to get user info: ${JSON.stringify(error)}`));
            return;
          }

          try {
            const userData = JSON.parse(data as string);
            resolve({
              id: userData.id_str,
              name: userData.name,
              username: userData.screen_name,
            });
          } catch (parseError) {
            reject(new Error(`Failed to parse user data: ${parseError}`));
          }
        }
      );
    });
  }

  /**
   * Check if user follows a specific account on Twitter
   */
  public async checkFollowingRelationship(
    accessToken: string,
    accessTokenSecret: string,
    sourceScreenName: string,
    targetScreenName: string
  ): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const url = `${this.FRIENDSHIPS_SHOW_URL}?source_screen_name=${encodeURIComponent(sourceScreenName)}&target_screen_name=${encodeURIComponent(targetScreenName)}`;

      this.oauth.get(url, accessToken, accessTokenSecret, (error, data) => {
        if (error) {
          reject(new Error(`Failed to check friendship: ${JSON.stringify(error)}`));
          return;
        }

        try {
          const friendshipData: FriendshipData = JSON.parse(data as string);
          resolve(friendshipData.relationship.source.following);
        } catch (parseError) {
          reject(new Error(`Failed to parse friendship data: ${parseError}`));
        }
      });
    });
  }

  /**
   * Complete OAuth flow: exchange token and get user info + following status
   */
  public async completeOAuthFlow(
    oauthToken: string,
    oauthVerifier: string
  ): Promise<{ walletAddress: string; twitterUser: TwitterUserData; isFollowingJuiceSwap: boolean }> {
    // Exchange token for access token
    const { accessToken, accessTokenSecret, walletAddress } = await this.getAccessToken(
      oauthToken,
      oauthVerifier
    );

    // Get user info
    const twitterUser = await this.getUserInfo(accessToken, accessTokenSecret);

    // Check if user follows JuiceSwap
    const juiceSwapUsername = process.env.JUICESWAP_TWITTER_USERNAME;
    let isFollowingJuiceSwap = false;

    if (juiceSwapUsername) {
      try {
        isFollowingJuiceSwap = await this.checkFollowingRelationship(
          accessToken,
          accessTokenSecret,
          twitterUser.username,
          juiceSwapUsername
        );
      } catch (error) {
        // Log error but don't fail the OAuth flow
        console.error('Failed to check Twitter following relationship:', error);
        throw new Error(
          'Failed to verify Twitter following status. Please make sure you follow @' + juiceSwapUsername
        );
      }
    } else {
      console.warn('JUICESWAP_TWITTER_USERNAME not configured, skipping following check');
    }

    return {
      walletAddress,
      twitterUser,
      isFollowingJuiceSwap,
    };
  }

  /**
   * Clean up expired sessions from database
   * Runs every 5 minutes to remove sessions older than expiry time
   */
  private async cleanupSessions(): Promise<void> {
    try {
      const result = await prisma.twitterOAuthSession.deleteMany({
        where: {
          expiresAt: {
            lt: new Date(),
          },
        },
      });

      if (result.count > 0) {
        console.log(`Cleaned up ${result.count} expired Twitter OAuth sessions`);
      }
    } catch (error) {
      console.error('Error cleaning up Twitter OAuth sessions:', error);
    }
  }
}

// Singleton instance
let twitterOAuthService: TwitterOAuthService | null = null;

/**
 * Get or create TwitterOAuthService instance
 */
export function getTwitterOAuthService(): TwitterOAuthService {
  if (!twitterOAuthService) {
    const config = {
      consumerKey: process.env.TWITTER_CONSUMER_KEY || '',
      consumerSecret: process.env.TWITTER_CONSUMER_SECRET || '',
      callbackUrl: process.env.TWITTER_CALLBACK_URL || '',
    };

    if (!config.consumerKey || !config.consumerSecret || !config.callbackUrl) {
      throw new Error('Missing Twitter OAuth environment variables');
    }

    twitterOAuthService = new TwitterOAuthService(config);
  }

  return twitterOAuthService;
}
