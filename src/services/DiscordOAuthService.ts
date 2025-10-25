import axios from 'axios';
import { generateState } from '../utils/pkce';
import { prisma } from '../db/prisma';

/**
 * Discord OAuth 2.0 Service
 * Handles Discord authentication flow (standard Authorization Code Grant)
 * Uses database for persistent session storage (production-ready)
 * Verifies user is member of specified Discord guild (server)
 * Note: Does not use PKCE (PUBLIC CLIENT = OFF, confidential client)
 */

interface DiscordOAuthConfig {
  clientId: string;
  clientSecret: string;
  botToken: string;
  callbackUrl: string;
  guildId: string;
}

interface DiscordTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
}

interface DiscordUserData {
  id: string;
  username: string;
  discriminator: string;
  global_name?: string;
  avatar?: string;
}

interface DiscordGuild {
  id: string;
  name: string;
  icon?: string;
  owner: boolean;
  permissions: string;
}

export class DiscordOAuthService {
  private config: DiscordOAuthConfig;
  private cleanupIntervalId: NodeJS.Timeout | null = null;

  // OAuth URLs (API v10)
  private readonly AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';
  private readonly TOKEN_URL = 'https://discord.com/api/v10/oauth2/token';
  private readonly USER_INFO_URL = 'https://discord.com/api/v10/users/@me';
  private readonly USER_GUILDS_URL = 'https://discord.com/api/v10/users/@me/guilds';
  private readonly ADD_GUILD_MEMBER_URL = 'https://discord.com/api/v10/guilds';

  // OAuth scopes: identify (user info) + guilds (guild list) + guilds.join (auto-add to guild)
  private readonly SCOPES = 'identify guilds guilds.join';

  // Session expiry time (10 minutes)
  private readonly SESSION_EXPIRY_MS = 10 * 60 * 1000;

  constructor(config: DiscordOAuthConfig) {
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
   * Uses standard OAuth 2.0 flow (no PKCE for confidential clients)
   */
  public async generateAuthUrl(walletAddress: string): Promise<{ authUrl: string; state: string }> {
    // Generate state for CSRF protection
    const state = generateState();

    // Calculate expiry time (10 minutes from now)
    const expiresAt = new Date(Date.now() + this.SESSION_EXPIRY_MS);

    // Store session in database
    await prisma.discordOAuthSession.create({
      data: {
        state,
        walletAddress,
        expiresAt,
      },
    });

    // Build authorization URL (standard OAuth 2.0, no PKCE)
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: this.config.callbackUrl,
      scope: this.SCOPES,
      state,
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
    const session = await prisma.discordOAuthSession.findUnique({
      where: { state },
    });

    if (!session) {
      throw new Error('Invalid or expired state token');
    }

    // Check if session has expired
    if (session.expiresAt < new Date()) {
      // Delete expired session
      await prisma.discordOAuthSession.delete({ where: { state } });
      throw new Error('Session has expired. Please try again.');
    }

    try {
      // Exchange code for token (standard OAuth 2.0, no PKCE)
      // Discord requires application/x-www-form-urlencoded
      const response = await axios.post<DiscordTokenResponse>(
        this.TOKEN_URL,
        new URLSearchParams({
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          grant_type: 'authorization_code',
          code,
          redirect_uri: this.config.callbackUrl,
        }),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );

      // Clean up session from database (consumed)
      await prisma.discordOAuthSession.delete({ where: { state } });

      return {
        accessToken: response.data.access_token,
        walletAddress: session.walletAddress,
      };
    } catch (error) {
      // Clean up session on error
      await prisma.discordOAuthSession.delete({ where: { state } }).catch(() => {
        // Ignore errors if already deleted
      });

      if (axios.isAxiosError(error)) {
        throw new Error(
          `Discord token exchange failed: ${error.response?.data?.error_description || error.message}`
        );
      }
      throw error;
    }
  }

  /**
   * Get authenticated user's Discord profile
   */
  public async getUserInfo(accessToken: string): Promise<DiscordUserData> {
    try {
      const response = await axios.get<DiscordUserData>(this.USER_INFO_URL, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(`Failed to get Discord user info: ${error.response?.data?.message || error.message}`);
      }
      throw error;
    }
  }

  /**
   * Get user's Discord guilds (servers)
   */
  public async getUserGuilds(accessToken: string): Promise<DiscordGuild[]> {
    try {
      const response = await axios.get<DiscordGuild[]>(this.USER_GUILDS_URL, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(`Failed to get Discord guilds: ${error.response?.data?.message || error.message}`);
      }
      throw error;
    }
  }

  /**
   * Check if user is member of the JuiceSwap Discord guild
   */
  public async isUserInGuild(accessToken: string): Promise<boolean> {
    const guilds = await this.getUserGuilds(accessToken);
    return guilds.some((guild) => guild.id === this.config.guildId);
  }

  /**
   * Add user to the JuiceSwap Discord guild
   * Requires guilds.join scope from user OAuth and bot to be in the guild
   * Uses Bot token to make the API call
   */
  public async addUserToGuild(userId: string, accessToken: string): Promise<void> {
    try {
      const url = `${this.ADD_GUILD_MEMBER_URL}/${this.config.guildId}/members/${userId}`;

      await axios.put(
        url,
        {
          access_token: accessToken,
        },
        {
          headers: {
            Authorization: `Bot ${this.config.botToken}`,
            'Content-Type': 'application/json',
          },
        }
      );
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(
          `Failed to add user to Discord guild: ${error.response?.data?.message || error.message}`
        );
      }
      throw error;
    }
  }

  /**
   * Complete OAuth flow: exchange code, get user info, add to guild, and verify membership
   */
  public async completeOAuthFlow(
    code: string,
    state: string
  ): Promise<{ walletAddress: string; discordUser: DiscordUserData; isInGuild: boolean }> {
    // Exchange code for token
    const { accessToken, walletAddress } = await this.exchangeCodeForToken(code, state);

    // Get user info
    const discordUser = await this.getUserInfo(accessToken);

    // Add user to Discord guild (auto-invite with guilds.join scope)
    await this.addUserToGuild(discordUser.id, accessToken);

    // Check if user is in the JuiceSwap Discord guild (should be true after auto-add)
    const isInGuild = await this.isUserInGuild(accessToken);

    return {
      walletAddress,
      discordUser,
      isInGuild,
    };
  }

  /**
   * Clean up expired sessions from database
   * Runs every 5 minutes to remove sessions older than expiry time
   */
  private async cleanupSessions(): Promise<void> {
    try {
      const result = await prisma.discordOAuthSession.deleteMany({
        where: {
          expiresAt: {
            lt: new Date(),
          },
        },
      });

      if (result.count > 0) {
        console.log(`Cleaned up ${result.count} expired Discord OAuth sessions`);
      }
    } catch (error) {
      console.error('Error cleaning up Discord OAuth sessions:', error);
    }
  }
}

// Singleton instance
let discordOAuthService: DiscordOAuthService | null = null;

/**
 * Get or create DiscordOAuthService instance
 */
export function getDiscordOAuthService(): DiscordOAuthService {
  if (!discordOAuthService) {
    const config = {
      clientId: process.env.DISCORD_CLIENT_ID || '',
      clientSecret: process.env.DISCORD_CLIENT_SECRET || '',
      botToken: process.env.DISCORD_BOT_TOKEN || '',
      callbackUrl: process.env.DISCORD_CALLBACK_URL || '',
      guildId: process.env.DISCORD_GUILD_ID || '',
    };

    if (!config.clientId || !config.clientSecret || !config.botToken || !config.callbackUrl || !config.guildId) {
      throw new Error('Missing Discord OAuth environment variables');
    }

    discordOAuthService = new DiscordOAuthService(config);
  }

  return discordOAuthService;
}
