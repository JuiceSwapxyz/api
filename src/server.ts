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
  createTotalAddressesWithIpHandler,
  createUniqueIpHashesHandler,
} from './endpoints/userMetrics';
import {
  createTwitterStartHandler,
  createTwitterCallbackHandler,
  createTwitterStatusHandler,
  createDiscordStartHandler,
  createDiscordCallbackHandler,
  createDiscordStatusHandler,
  createBAppsStatusHandler,
  createNFTSignatureHandler,
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

  // User metrics endpoint handlers
  const handleTotalAddressesWithIp = createTotalAddressesWithIpHandler(logger);
  const handleUniqueIpHashes = createUniqueIpHashesHandler(logger);

  // Campaign endpoint handlers
  const handleTwitterStart = createTwitterStartHandler(logger);
  const handleTwitterCallback = createTwitterCallbackHandler(logger);
  const handleTwitterStatus = createTwitterStatusHandler(logger);
  const handleDiscordStart = createDiscordStartHandler(logger);
  const handleDiscordCallback = createDiscordCallbackHandler(logger);
  const handleDiscordStatus = createDiscordStatusHandler(logger);
  const handleBAppsStatus = createBAppsStatusHandler(logger);
  const handleNFTSignature = createNFTSignatureHandler(logger);

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

  // User metrics endpoints
  app.get('/v1/metrics/users/total-with-ip', handleTotalAddressesWithIp);
  app.get('/v1/metrics/users/unique-ips', handleUniqueIpHashes);

  // Campaign endpoints - Twitter OAuth
  app.get('/v1/campaigns/first-squeezer/twitter/start', generalLimiter, handleTwitterStart);
  app.get('/v1/campaigns/first-squeezer/twitter/callback', generalLimiter, handleTwitterCallback);
  app.get('/v1/campaigns/first-squeezer/twitter/status', generalLimiter, handleTwitterStatus);

  // Campaign endpoints - Discord OAuth
  app.get('/v1/campaigns/first-squeezer/discord/start', generalLimiter, handleDiscordStart);
  app.get('/v1/campaigns/first-squeezer/discord/callback', generalLimiter, handleDiscordCallback);
  app.get('/v1/campaigns/first-squeezer/discord/status', generalLimiter, handleDiscordStatus);

  // Campaign endpoints - bApps Verification
  app.get('/v1/campaigns/first-squeezer/bapps/status', generalLimiter, handleBAppsStatus);

  // Campaign endpoints - NFT Claiming
  app.get('/v1/campaigns/first-squeezer/nft/signature', generalLimiter, handleNFTSignature);

  // GraphQL endpoint
  app.use('/v1/graphql', await getApolloMiddleware(logger));

  // Root landing page
  app.get('/', (_req: Request, res: Response) => {
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>JuiceSwap API</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      background: linear-gradient(rgb(19, 19, 19) 0%, rgb(19, 19, 19) 100%);
      color: #ffffff;
      font-family: 'Courier New', monospace;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      -webkit-font-smoothing: antialiased;
    }
    .container {
      text-align: center;
      padding: 2rem;
      max-width: 800px;
    }
    .ascii-art {
      font-size: 0.8rem;
      line-height: 1.2;
      white-space: pre;
      margin-bottom: 3rem;
      color: #ffb8e2;
      text-shadow: 0 0 20px rgba(255, 184, 226, 0.3);
    }
    .links {
      margin-top: 2rem;
    }
    .links a {
      display: block;
      color: #ffffff;
      text-decoration: none;
      margin: 1rem 0;
      font-size: 1.2rem;
      transition: all 0.3s ease;
      padding: 0.5rem;
      border-radius: 8px;
    }
    .links a:hover {
      background: rgba(255, 184, 226, 0.1);
      color: #ffb8e2;
    }
    @media (max-width: 768px) {
      .ascii-art {
        font-size: 0.5rem;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="ascii-art">
     __     _          ____                         ___    ____  ____
    / /_ __(_)_______ / __/    ______ ____     __ / _ \\  / __/ /  _/
   / / // / / __/ -_)\\ \\| |/|/ / _ `/ _ \\   / // / ___/ _\\ \\  _/ /
  /_/\\_,_/_/\\__/\\__/___/|__,__/\\_,_/ .__/   \\___/_/    /___/ /___/
                                   /_/
    </div>
    <div class="links">
      <a href="/swagger">→ API Documentation (Swagger)</a>
      <a href="https://github.com/JuiceSwapxyz" target="_blank">→ GitHub</a>
      <a href="/version">→ Version Info</a>
      <a href="/metrics">→ Metrics</a>
    </div>
  </div>
</body>
</html>`);
  });

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

    const trackedUsers = await prisma.user.count({
      where: { ipAddressHash: { not: null } }
    }).catch((error) => {
      logger.warn({ error }, 'Failed to fetch tracked users for metrics');
      return -1;
    });

    const uniqueIpResult = await prisma.user.groupBy({
      by: ['ipAddressHash'],
      where: { ipAddressHash: { not: null } },
      _count: true,
    }).catch((error) => {
      logger.warn({ error }, 'Failed to fetch unique IPs for metrics');
      return [];
    });

    res.json({
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      chains: routerService.getSupportedChains(),
      userCount,
      trackedUsers,
      uniqueIps: uniqueIpResult.length,
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