import { GraphQLClient } from 'graphql-request';

export interface GraphQLServiceConfig {
  endpoint: string;
  headers?: Record<string, string>;
}

export class GraphqlPonderService {
  private client: GraphQLClient;

  constructor(config: GraphQLServiceConfig) {
    this.client = new GraphQLClient(config.endpoint, {
      headers: config.headers,
    });
  }

  /**
   * Execute a GraphQL query
   */
  async query<T = any>(
    query: string,
    variables?: Record<string, any>
  ): Promise<T> {
    return this.client.request<T>(query, variables);
  }
}

/**
 * Factory function to create a GraphQL service instance
 */
export function createGraphQLService(config: GraphQLServiceConfig): GraphqlPonderService {
  return new GraphqlPonderService(config);
}

/**
 * Default service instance for Ponder GraphQL endpoint
 */
export const ponderGraphQLService = createGraphQLService({
  endpoint: `${process.env.PONDER_URL}/graphql`,
  headers: {
    'User-Agent': 'API-Service/1.0',
  },
});
