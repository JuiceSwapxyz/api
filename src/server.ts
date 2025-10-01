import 'dotenv/config';
import express, { Request, Response } from 'express';
import Logger from 'bunyan';
import { RouterService } from './core/RouterService';
import { initializeProviders, verifyProviders } from './providers/rpcProvider';
import { createQuoteHandler } from './endpoints/quote';
import { createSwapHandler } from './endpoints/swap';
import { createSwappableTokensHandler } from './endpoints/swappableTokens';
import { createSwapsHandler } from './endpoints/swaps';
import { createLpApproveHandler } from './endpoints/lpApprove';
import { createLpCreateHandler } from './endpoints/lpCreate';
import { quoteLimiter, generalLimiter } from './middleware/rateLimiter';
import { getApolloMiddleware } from './adapters/handleGraphQL';
import { initializeResolvers } from './adapters/handleGraphQL/resolvers';

// Initialize logger
const logger = Logger.createLogger({
  name: 'juiceswap-routing-api',
  level: (process.env.LOG_LEVEL as Logger.LogLevel) || 'info',
  serializers: Logger.stdSerializers,
});

async function bootstrap() {
  logger.info('Starting JuiceSwap Clean Routing API...');

  // Initialize RPC providers
  const providers = initializeProviders(logger);

  // Verify provider connectivity
  await verifyProviders(providers, logger);

  // Initialize router service with Ponder integration
  const routerService = await RouterService.create(providers, logger);

  // Initialize GraphQL resolvers
  initializeResolvers(routerService, logger);

  // Create Express app
  const app = express();

  // Trust proxy for rate limiting
  app.set('trust proxy', true);

  // Body parsing middleware
  app.use(express.json({ limit: '1mb' }));

  // CORS configuration
  const corsOrigins = process.env.CORS_ORIGINS?.split(',').map(o => o.trim()) || [
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:3002',
    'https://app.juiceswap.com',
    'https://dev.app.juiceswap.com',
  ];

  app.use((req, res, next) => {
    const origin = req.headers.origin;

    // Check if origin is allowed
    if (origin) {
      // Check exact match
      if (corsOrigins.includes(origin)) {
        res.header('Access-Control-Allow-Origin', origin);
      }
      // Check if it's a juiceswap.com subdomain
      else if (/^https?:\/\/([\w-]+\.)?juiceswap\.com(:\d+)?$/.test(origin)) {
        res.header('Access-Control-Allow-Origin', origin);
      }
    } else {
      // No origin header (e.g., server-to-server request)
      res.header('Access-Control-Allow-Origin', corsOrigins[0]);
    }

    res.header(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, x-request-id, x-api-key'
    );
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

    if (req.method === 'OPTIONS') {
      res.sendStatus(200);
    } else {
      next();
    }
  });

  // Request logging middleware
  app.use((req, res, next) => {
    const requestId = req.headers['x-request-id'] as string ||
                     `${req.method}-${Date.now()}`;
    req.headers['x-request-id'] = requestId;

    logger.info({
      requestId,
      method: req.method,
      path: req.path,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    }, 'Incoming request');

    // Log response
    const originalSend = res.send;
    res.send = function(data) {
      logger.info({
        requestId,
        statusCode: res.statusCode,
        responseTime: res.getHeader('X-Response-Time'),
      }, 'Request completed');
      return originalSend.call(this, data);
    };

    next();
  });

  // Create endpoint handlers
  const handleQuote = createQuoteHandler(routerService, logger);
  const handleSwap = createSwapHandler(routerService, logger);
  const handleSwappableTokens = createSwappableTokensHandler(logger);
  const handleSwaps = createSwapsHandler(routerService, logger);
  const handleLpApprove = createLpApproveHandler(routerService, logger);
  const handleLpCreate = createLpCreateHandler(routerService, logger);

  // API Routes
  app.post('/v1/quote', quoteLimiter, handleQuote);
  app.post('/v1/swap', generalLimiter, handleSwap);

  // Swappable tokens endpoint (returns supported tokens)
  app.get('/v1/swappable_tokens', handleSwappableTokens);

  // LP endpoints
  app.post('/v1/lp/approve', generalLimiter, handleLpApprove);
  app.post('/v1/lp/create', generalLimiter, handleLpCreate);

  // Swaps transaction status endpoint
  app.get('/v1/swaps', handleSwaps);

  // GraphQL endpoint
  app.use('/v1/graphql', await getApolloMiddleware());

  // Health check endpoints
  app.get('/healthz', (_req: Request, res: Response) => {
    res.status(200).send('ok');
  });

  app.get('/readyz', async (_req: Request, res: Response) => {
    // Check if at least one provider is working
    const chains = routerService.getSupportedChains();
    if (chains.length > 0) {
      res.status(200).send('ready');
    } else {
      res.status(503).send('not ready');
    }
  });

  // Version endpoint
  app.get('/version', (_req: Request, res: Response) => {
    const packageJson = require('../package.json');
    res.json({
      name: packageJson.name,
      version: packageJson.version,
      node: process.version,
      environment: process.env.NODE_ENV || 'development',
    });
  });

  // Metrics endpoint (basic)
  app.get('/metrics', (_req: Request, res: Response) => {
    res.json({
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      chains: routerService.getSupportedChains(),
    });
  });

  // 404 handler
  app.use((req: Request, res: Response) => {
    logger.warn({ path: req.path, method: req.method }, 'Route not found');
    res.status(404).json({
      error: 'Not found',
      detail: `The endpoint ${req.method} ${req.path} does not exist`,
    });
  });

  // Error handler
  app.use((err: any, req: Request, res: Response, _next: any) => {
    logger.error({ error: err, path: req.path }, 'Unhandled error');
    res.status(500).json({
      error: 'Internal server error',
      detail: process.env.NODE_ENV === 'development' ? err.message : 'An error occurred',
    });
  });

  // Start server
  const port = parseInt(process.env.PORT || '3000');
  const server = app.listen(port, '0.0.0.0', () => {
    logger.info({ port }, `JuiceSwap Routing API listening on port ${port}`);
    logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
    logger.info(`Supported chains: ${routerService.getSupportedChains().join(', ')}`);
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, starting graceful shutdown...`);

    server.close(() => {
      logger.info('HTTP server closed');
      process.exit(0);
    });

    // Force shutdown after 10 seconds
    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Start the application
bootstrap().catch((error) => {
  console.error('Failed to start application:', error);
  logger.fatal({
    error: error.message,
    stack: error.stack,
    name: error.name
  }, 'Failed to start application');
  process.exit(1);
});