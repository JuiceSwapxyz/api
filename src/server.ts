import 'dotenv/config';
import express, { Request, Response } from 'express';
import Logger from 'bunyan';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './swagger/config';
import { RouterService } from './core/RouterService';
import { initializeProviders, verifyProviders } from './providers/rpcProvider';
import { createQuoteHandler } from './endpoints/quote';
import { createSwapHandler } from './endpoints/swap';
import { createSwappableTokensHandler } from './endpoints/swappableTokens';
import { createSwapsHandler } from './endpoints/swaps';
import { createLpApproveHandler } from './endpoints/lpApprove';
import { createLpCreateHandler } from './endpoints/lpCreate';
import { createPortfolioHandler } from './endpoints/portfolio';
import {
  createTwitterStartHandler,
  createTwitterCallbackHandler,
  createTwitterStatusHandler,
} from './endpoints/firstSqueezerCampaign';
import { quoteLimiter, generalLimiter } from './middleware/rateLimiter';
import { validateBody, validateQuery } from './middleware/validation';
import { getApolloMiddleware } from './adapters/handleGraphQL';
import { initializeResolvers } from './adapters/handleGraphQL/resolvers';
import { quoteCache } from './cache/quoteCache';
import { portfolioCache } from './cache/portfolioCache';
import { prisma } from './db/prisma';
import {
  QuoteRequestSchema,
  SwapRequestSchema,
  SwappableTokensQuerySchema,
  SwapsQuerySchema,
  LpApproveRequestSchema,
  LpCreateRequestSchema,
  PortfolioQuerySchema,
} from './validation/schemas';
import packageJson from '../package.json';

// Initialize logger
const logger = Logger.createLogger({
  name: 'juiceswap-routing-api',
  level: (process.env.LOG_LEVEL as Logger.LogLevel) || 'info',
  serializers: Logger.stdSerializers,
});

async function bootstrap() {
  logger.info('Starting JuiceSwap Clean Routing API...');

  // Initialize quote cache with logger
  quoteCache.setLogger(logger);

  // Initialize portfolio cache with logger
  portfolioCache.setLogger(logger);

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

  // Security headers with Helmet (configured for API use)
  app.use(helmet({
    contentSecurityPolicy: false, // Disable CSP for API
    crossOriginEmbedderPolicy: false, // Allow embedding (for Swagger UI)
  }));

  // CORS configuration
  const corsOrigins = process.env.CORS_ORIGINS?.split(',').map(o => o.trim()) || [
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:3002',
    'https://bapp.juiceswap.com',
    'https://dev.bapp.juiceswap.com',
  ];

  app.use((req, res, next) => {
    const origin = req.headers.origin;

    // Check if origin is allowed
    if (origin) {
      // Check exact match
      if (corsOrigins.includes(origin)) {
        res.header('Access-Control-Allow-Origin', origin);
      }
      // Check if it's a juiceswap.com or juiceswap.xyz subdomain (supports multi-level subdomains)
      else if (/^https?:\/\/([\w-]+\.)*juiceswap\.(com|xyz)(:\d+)?$/.test(origin)) {
        res.header('Access-Control-Allow-Origin', origin);
      }
    } else {
      // No origin header (e.g., server-to-server request)
      res.header('Access-Control-Allow-Origin', corsOrigins[0]);
    }

    res.header(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, x-request-source, x-app-version, x-api-key, x-universal-router-version, x-viem-provider-enabled, x-uniquote-enabled'
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

    logger.debug({
      requestId,
      method: req.method,
      path: req.path,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    }, 'Incoming request');

    // Log response
    const originalSend = res.send;
    res.send = function(data) {
      logger.debug({
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
  const handlePortfolio = createPortfolioHandler(providers, logger);

  // Campaign endpoint handlers
  const handleTwitterStart = createTwitterStartHandler(logger);
  const handleTwitterCallback = createTwitterCallbackHandler(logger);
  const handleTwitterStatus = createTwitterStatusHandler(logger);

  // API Routes with validation
  app.post('/v1/quote', quoteLimiter, validateBody(QuoteRequestSchema, logger), handleQuote);
  app.post('/v1/swap', generalLimiter, validateBody(SwapRequestSchema, logger), handleSwap);

  // Swappable tokens endpoint (returns supported tokens)
  app.get('/v1/swappable_tokens', validateQuery(SwappableTokensQuerySchema, logger), handleSwappableTokens);

  // Portfolio endpoint (returns wallet token balances)
  app.get('/v1/portfolio/:address', generalLimiter, validateQuery(PortfolioQuerySchema, logger), handlePortfolio);

  // LP endpoints
  app.post('/v1/lp/approve', generalLimiter, validateBody(LpApproveRequestSchema, logger), handleLpApprove);
  app.post('/v1/lp/create', generalLimiter, validateBody(LpCreateRequestSchema, logger), handleLpCreate);

  // Swaps transaction status endpoint
  app.get('/v1/swaps', validateQuery(SwapsQuerySchema, logger), handleSwaps);

  // Campaign endpoints - Twitter OAuth
  app.get('/v1/campaigns/first-squeezer/twitter/start', generalLimiter, handleTwitterStart);
  app.get('/v1/campaigns/first-squeezer/twitter/callback', generalLimiter, handleTwitterCallback);
  app.get('/v1/campaigns/first-squeezer/twitter/status', generalLimiter, handleTwitterStatus);

  // GraphQL endpoint
  app.use('/v1/graphql', await getApolloMiddleware(logger));

  // API Documentation (Swagger UI)
  app.use('/swagger', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
    customCss: '.swagger-ui .topbar { display: none }',
    customSiteTitle: 'JuiceSwap API Documentation',
  }));

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
    res.json({
      name: packageJson.name,
      version: packageJson.version,
      node: process.version,
      environment: process.env.NODE_ENV || 'development',
    });
  });

  // Metrics endpoint (basic)
  app.get('/metrics', async (_req: Request, res: Response) => {
    const userCount = await prisma.user.count().catch((error) => {
      logger.warn({ error }, 'Failed to fetch user count for metrics');
      return -1;
    });

    res.json({
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      chains: routerService.getSupportedChains(),
      userCount,
      quoteCache: quoteCache.getStats(),
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
  logger.fatal({
    error: error.message,
    stack: error.stack,
    name: error.name
  }, 'Failed to start application');
  process.exit(1);
});