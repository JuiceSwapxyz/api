import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@apollo/server/express4';
import { typeDefs } from './schema';
import { resolvers } from './resolvers';
import { Request } from 'express';
import Logger from 'bunyan';

let apolloServer: ApolloServer | null = null;
let logger: Logger;

export const initApolloServer = async (log: Logger) => {
  logger = log.child({ component: 'apollo-server' });

  if (apolloServer) {
    return apolloServer;
  }

  apolloServer = new ApolloServer({
    typeDefs,
    resolvers,
    introspection: true,
    includeStacktraceInErrorResponses: process.env.NODE_ENV !== 'production',
  });

  await apolloServer.start();
  logger.info('Apollo Server started successfully');
  return apolloServer;
};

export const getApolloMiddleware = async (log: Logger) => {
  try {
    const server = await initApolloServer(log);
    return expressMiddleware(server, {
      context: async ({ req }: { req: Request }) => ({
        headers: req.headers,
        ip: req.ip,
      }),
    });
  } catch (error) {
    log.error({ error }, 'Failed to initialize Apollo Server');
    throw error;
  }
};