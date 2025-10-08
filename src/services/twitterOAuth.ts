import axios from 'axios';
import Logger from 'bunyan';
import crypto from 'crypto';

interface TwitterUser {
  id: string;
  username: string;
  name: string;
}

interface TwitterOAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
}

interface TwitterFollowingResponse {
  data?: Array<{
    id: string;
    username: string;
    name: string;
  }>;
  meta?: {
    result_count: number;
  };
}

export class TwitterOAuthService {
  private clientId: string;
  private clientSecret: string;
  private callbackUrl: string;
  private juiceswapUserId: string;
  private logger: Logger;

  // PKCE state management (in-memory for now, should be Redis/DB in production)
  private pkceStore: Map<string, { codeVerifier: string; state: string }> = new Map();

  constructor(logger: Logger) {
    this.clientId = process.env.TWITTER_CLIENT_ID || '';
    this.clientSecret = process.env.TWITTER_CLIENT_SECRET || '';
    this.callbackUrl = process.env.TWITTER_CALLBACK_URL || '';
    this.juiceswapUserId = process.env.JUICESWAP_TWITTER_USER_ID || '';
    this.logger = logger;

    if (!this.clientId || !this.clientSecret) {
      this.logger.warn('Twitter OAuth credentials not configured');
    }
  }

  /**
   * Generate PKCE code verifier and challenge for OAuth 2.0 flow
   */
  private generatePKCE(): { codeVerifier: string; codeChallenge: string } {
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto
      .createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');

    return { codeVerifier, codeChallenge };
  }

  /**
   * Generate authorization URL for Twitter OAuth 2.0
   * Returns the URL to redirect user to for authorization
   */
  generateAuthUrl(walletAddress: string): { url: string; state: string } {
    const state = crypto.randomBytes(16).toString('hex');
    const { codeVerifier, codeChallenge } = this.generatePKCE();

    // Store PKCE and state for verification
    this.pkceStore.set(walletAddress, { codeVerifier, state });

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: this.callbackUrl,
      scope: 'tweet.read users.read follows.read',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    const url = `https://twitter.com/i/oauth2/authorize?${params.toString()}`;

    this.logger.info({ walletAddress, state }, 'Generated Twitter auth URL');
    return { url, state };
  }

  /**
   * Exchange authorization code for access token
   */
  async exchangeCodeForToken(
    code: string,
    walletAddress: string
  ): Promise<TwitterOAuthTokens> {
    const pkceData = this.pkceStore.get(walletAddress);
    if (!pkceData) {
      throw new Error('PKCE verification failed: No stored verifier found');
    }

    try {
      const response = await axios.post(
        'https://api.twitter.com/2/oauth2/token',
        new URLSearchParams({
          code,
          grant_type: 'authorization_code',
          client_id: this.clientId,
          redirect_uri: this.callbackUrl,
          code_verifier: pkceData.codeVerifier,
        }).toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          auth: {
            username: this.clientId,
            password: this.clientSecret,
          },
        }
      );

      this.logger.info({ walletAddress }, 'Successfully exchanged code for token');

      // Clean up PKCE data
      this.pkceStore.delete(walletAddress);

      return {
        accessToken: response.data.access_token,
        refreshToken: response.data.refresh_token,
        expiresIn: response.data.expires_in,
      };
    } catch (error) {
      this.logger.error({ error, walletAddress }, 'Failed to exchange code for token');
      throw new Error('Failed to get access token from Twitter');
    }
  }

  /**
   * Get authenticated user's Twitter profile
   */
  async getUserProfile(accessToken: string): Promise<TwitterUser> {
    try {
      const response = await axios.get('https://api.twitter.com/2/users/me', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      const user = response.data.data;
      this.logger.info({ userId: user.id, username: user.username }, 'Fetched user profile');

      return {
        id: user.id,
        username: user.username,
        name: user.name,
      };
    } catch (error) {
      this.logger.error({ error }, 'Failed to fetch user profile');
      throw new Error('Failed to fetch Twitter user profile');
    }
  }

  /**
   * Check if user follows @JuiceSwap_com
   * Returns true if user follows JuiceSwap, false otherwise
   */
  async checkFollowsJuiceSwap(accessToken: string, userId: string): Promise<boolean> {
    try {
      // Check if user follows JuiceSwap
      // API: GET /2/users/:id/following
      const response = await axios.get<TwitterFollowingResponse>(
        `https://api.twitter.com/2/users/${userId}/following`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
          params: {
            max_results: 1000, // Check up to 1000 following
          },
        }
      );

      const following = response.data.data || [];
      const followsJuiceSwap = following.some(
        (user) => user.id === this.juiceswapUserId
      );

      this.logger.info(
        { userId, followsJuiceSwap, juiceswapUserId: this.juiceswapUserId },
        'Checked JuiceSwap follow status'
      );

      return followsJuiceSwap;
    } catch (error) {
      this.logger.error({ error, userId }, 'Failed to check follow status');
      throw new Error('Failed to verify Twitter follow status');
    }
  }

  /**
   * Complete OAuth flow: exchange code, get profile, check follow status
   * Returns user profile and follow status
   */
  async completeOAuthFlow(
    code: string,
    walletAddress: string
  ): Promise<{
    user: TwitterUser;
    followsJuiceSwap: boolean;
  }> {
    // Exchange code for token
    const tokens = await this.exchangeCodeForToken(code, walletAddress);

    // Get user profile
    const user = await this.getUserProfile(tokens.accessToken);

    // Check if user follows JuiceSwap
    const followsJuiceSwap = await this.checkFollowsJuiceSwap(
      tokens.accessToken,
      user.id
    );

    return { user, followsJuiceSwap };
  }

  /**
   * Verify state parameter matches stored state
   */
  verifyState(walletAddress: string, state: string): boolean {
    const pkceData = this.pkceStore.get(walletAddress);
    return pkceData?.state === state;
  }
}
