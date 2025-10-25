import axios from 'axios';
import Logger from 'bunyan';

/**
 * TwitterAPI.io Service
 * Third-party service for checking Twitter follow relationships
 * without needing Twitter's Elevated Access
 */

interface TwitterApiIoConfig {
  apiKey: string;
  logger?: Logger;
}

interface FollowRelationshipResponse {
  status: string;
  message: string;
  data: {
    following: boolean;
    followed_by: boolean;
  };
}

export class TwitterApiIoService {
  private readonly apiKey: string;
  private readonly logger: Logger;
  private readonly baseUrl = 'https://api.twitterapi.io/twitter/user';

  constructor(config: TwitterApiIoConfig) {
    this.apiKey = config.apiKey;
    this.logger = config.logger || Logger.createLogger({ name: 'TwitterApiIoService' });
  }

  /**
   * Check if sourceUsername follows targetUsername
   * @param sourceUsername - The username to check (e.g., the user authenticating)
   * @param targetUsername - The target username (e.g., "JuiceSwap")
   * @returns true if sourceUsername follows targetUsername, false otherwise
   */
  public async checkFollowRelationship(sourceUsername: string, targetUsername: string): Promise<boolean> {
    try {
      this.logger.debug(
        { sourceUsername, targetUsername },
        'Checking follow relationship via TwitterAPI.io'
      );

      const response = await axios.get<FollowRelationshipResponse>(
        `${this.baseUrl}/check_follow_relationship`,
        {
          params: {
            source_user_name: sourceUsername,
            target_user_name: targetUsername,
          },
          headers: {
            'x-api-key': this.apiKey,
          },
          timeout: 10000, // 10 second timeout
        }
      );

      if (response.data.status !== 'success') {
        this.logger.warn(
          { sourceUsername, targetUsername, response: response.data },
          'TwitterAPI.io returned non-success status'
        );
        return false;
      }

      const isFollowing = response.data.data.following;

      this.logger.info(
        { sourceUsername, targetUsername, isFollowing },
        'Follow relationship check completed'
      );

      return isFollowing;
    } catch (error: any) {
      this.logger.error(
        {
          error: error.message,
          statusCode: error.response?.status,
          responseData: error.response?.data,
          sourceUsername,
          targetUsername,
        },
        'Failed to check follow relationship via TwitterAPI.io'
      );

      // Return false on error (fail-closed approach for security)
      return false;
    }
  }
}

// Singleton instance
let twitterApiIoService: TwitterApiIoService | null = null;

/**
 * Get or create TwitterApiIoService instance
 */
export function getTwitterApiIoService(logger?: Logger): TwitterApiIoService {
  if (!twitterApiIoService) {
    const apiKey = process.env.TWITTER_API_IO_KEY;

    if (!apiKey) {
      throw new Error('TWITTER_API_IO_KEY environment variable is required');
    }

    twitterApiIoService = new TwitterApiIoService({
      apiKey,
      logger,
    });
  }

  return twitterApiIoService;
}
