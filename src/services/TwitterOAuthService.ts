import axios from 'axios';
import { generatePKCE, generateState } from '../utils/pkce';
import { prisma } from '../db/prisma';

/**
 * Twitter OAuth 2.0 Service
 * Handles Twitter authentication flow with PKCE
 * Uses database for persistent session storage (production-ready)
 */

interface TwitterOAuthConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
}

interface TwitterTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  refresh_token?: string;
}

interface TwitterUserData {
  id: string;
  name: string;
  username: string;
}

export class TwitterOAuthService {
  private config: TwitterOAuthConfig;
  private cleanupIntervalId: NodeJS.Timeout | null = null;

  // OAuth URLs
  private readonly AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize';
  private readonly TOKEN_URL = 'https://api.x.com/2/oauth2/token';
  private readonly USER_INFO_URL = 'https://api.x.com/2/users/me';

  // OAuth scopes (requires tweet.read for /users/me endpoint)
  private readonly SCOPES = 'users.read tweet.read';

  // Session expiry time (10 minutes)
  private readonly SESSION_EXPIRY_MS = 10 * 60 * 1000;

  constructor(config: TwitterOAuthConfig) {
    this.config = config;

    // Clean up expired sessions every 5 minutes
    // Note: In production, consider using external cron job instead
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
  public async generateAuthUrl(walletAddress: string): Promise<{ authUrl: string; state: string }> {
    // Generate PKCE parameters
    const { codeVerifier, codeChallenge } = generatePKCE();
    const state = generateState();

    // Calculate expiry time (10 minutes from now)
    const expiresAt = new Date(Date.now() + this.SESSION_EXPIRY_MS);

    // Store session in database
    await prisma.twitterOAuthSession.create({
      data: {
        state,
        walletAddress,
        codeVerifier,
        expiresAt,
      },
    });

    // Build authorization URL
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: this.config.callbackUrl,
      scope: this.SCOPES,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    const authUrl = `${this.AUTHORIZE_URL}?${params.toString()}`;

    return { authUrl, state };
  }

  /**
   * Exchange authorization code for access token
   * Retrieves and validates session from database
   */
  public async exchangeCodeForToken(
    code: string,
    state: string
  ): Promise<{ accessToken: string; walletAddress: string }> {
    // Retrieve session from database
    const session = await prisma.twitterOAuthSession.findUnique({
      where: { state },
    });

    if (!session) {
      throw new Error('Invalid or expired state token');
    }

    // Check if session has expired
    if (session.expiresAt < new Date()) {
      // Delete expired session
      await prisma.twitterOAuthSession.delete({ where: { state } });
      throw new Error('Session has expired. Please try again.');
    }

    // Basic auth credentials
    const credentials = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64');

    try {
      // Exchange code for token
      const response = await axios.post<TwitterTokenResponse>(
        this.TOKEN_URL,
        new URLSearchParams({
          code,
          grant_type: 'authorization_code',
          redirect_uri: this.config.callbackUrl,
          code_verifier: session.codeVerifier,
        }),
        {
          headers: {
            Authorization: `Basic ${credentials}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );

      // Clean up session from database (consumed)
      await prisma.twitterOAuthSession.delete({ where: { state } });

      return {
        accessToken: response.data.access_token,
        walletAddress: session.walletAddress,
      };
    } catch (error) {
      // Clean up session on error
      await prisma.twitterOAuthSession.delete({ where: { state } }).catch(() => {
        // Ignore errors if already deleted
      });

      if (axios.isAxiosError(error)) {
        throw new Error(`Twitter token exchange failed: ${error.response?.data?.error_description || error.message}`);
      }
      throw error;
    }
  }

  /**
   * Get authenticated user's Twitter profile
   */
  public async getUserInfo(accessToken: string): Promise<TwitterUserData> {
    try {
      const response = await axios.get<{ data: TwitterUserData }>(this.USER_INFO_URL, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      return response.data.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(`Failed to get Twitter user info: ${error.response?.data?.error || error.message}`);
      }
      throw error;
    }
  }

  /**
   * Complete OAuth flow: exchange code and get user info
   */
  public async completeOAuthFlow(
    code: string,
    state: string
  ): Promise<{ walletAddress: string; twitterUser: TwitterUserData }> {
    // Exchange code for token
    const { accessToken, walletAddress } = await this.exchangeCodeForToken(code, state);

    // Get user info
    const twitterUser = await this.getUserInfo(accessToken);

    return {
      walletAddress,
      twitterUser,
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
      clientId: process.env.TWITTER_CLIENT_ID || '',
      clientSecret: process.env.TWITTER_CLIENT_SECRET || '',
      callbackUrl: process.env.TWITTER_CALLBACK_URL || '',
    };

    if (!config.clientId || !config.clientSecret || !config.callbackUrl) {
      throw new Error('Missing Twitter OAuth environment variables');
    }

    twitterOAuthService = new TwitterOAuthService(config);
  }

  return twitterOAuthService;
}
