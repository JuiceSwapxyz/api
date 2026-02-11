import "dotenv/config";
import express, { Request, Response } from "express";
import Logger from "bunyan";
import helmet from "helmet";
import swaggerUi from "swagger-ui-express";
import { swaggerSpec } from "./swagger/config";
import { RouterService } from "./core/RouterService";
import { initializeProviders, verifyProviders } from "./providers/rpcProvider";
import { createQuoteHandler } from "./endpoints/quote";
import { createSwapHandler } from "./endpoints/swap";
import { JuiceGatewayService } from "./services/JuiceGatewayService";
import { SvJusdPriceService } from "./services/SvJusdPriceService";
import { createSvJusdSharePriceHandler } from "./endpoints/svJusdSharePrice";
import { createSwappableTokensHandler } from "./endpoints/swappableTokens";
import { createSwapsHandler } from "./endpoints/swaps";
import { createLpApproveHandler } from "./endpoints/lpApprove";
import { createLpCreateHandler } from "./endpoints/lpCreate";
import { createLpIncreaseHandler } from "./endpoints/lpIncrease";
import { createLpDecreaseHandler } from "./endpoints/lpDecrease";
import { createLpClaimHandler } from "./endpoints/lpClaim";
import { createPortfolioHandler } from "./endpoints/portfolio";
import {
  createLaunchpadTokensHandler,
  createLaunchpadTokenHandler,
  createLaunchpadTokenTradesHandler,
  createLaunchpadStatsHandler,
  createLaunchpadRecentTradesHandler,
} from "./endpoints/launchpad";
import {
  createUploadImageHandler,
  createUploadMetadataHandler,
} from "./endpoints/launchpadMetadata";
import {
  createTotalAddressesWithIpHandler,
  createUniqueIpHashesHandler,
} from "./endpoints/userMetrics";
import {
  createTwitterStartHandler,
  createTwitterCallbackHandler,
  createTwitterStatusHandler,
  createDiscordStartHandler,
  createDiscordCallbackHandler,
  createDiscordStatusHandler,
  createBAppsStatusHandler,
  createNFTSignatureHandler,
} from "./endpoints/firstSqueezerCampaign";
import { quoteLimiter, generalLimiter } from "./middleware/rateLimiter";
import { validateBody, validateQuery } from "./middleware/validation";
import { getApolloMiddleware } from "./adapters/handleGraphQL";
import { initializeResolvers } from "./adapters/handleGraphQL/resolvers";
import { quoteCache } from "./cache/quoteCache";
import { portfolioCache } from "./cache/portfolioCache";
import { setLaunchpadTokenServiceLogger } from "./services/LaunchpadTokenService";
import { prisma } from "./db/prisma";
import {
  QuoteRequestSchema,
  SwapRequestSchema,
  SwappableTokensQuerySchema,
  SwapsQuerySchema,
  LpApproveRequestSchema,
  LpCreateRequestSchema,
  LpIncreaseRequestSchema,
  LpDecreaseRequestSchema,
  LpClaimRequestSchema,
  PortfolioQuerySchema,
  SwapApproveRequestSchema,
  LaunchpadTokensQuerySchema,
  LaunchpadTradesQuerySchema,
  LaunchpadRecentTradesQuerySchema,
  LightningInvoiceRequestSchema,
  LightningAddressRequestSchema,
  LaunchpadUploadMetadataSchema,
  PositionInfoQuerySchema,
  PoolDetailsRequestSchema,
  PositionsOwnerRequestSchema,
  ProtocolStatsRequestSchema,
  CreateBridgeSwapSchema,
  BulkCreateBridgeSwapSchema,
  GetBridgeSwapsByUserQuerySchema,
  AuthVerifyRequestSchema,
} from "./validation/schemas";
import packageJson from "../package.json";
import { createSwapApproveHandler } from "./endpoints/swapApprove";
import { createLightningInvoiceHandler } from "./endpoints/lightningInvoice";
import { createValidateLightningAddressHandler } from "./endpoints/validateLightningAddress";
import { createPositionInfoHandler } from "./endpoints/positionInfo";
import { createPositionsOwnerHandler } from "./endpoints/positionsOwner";
import { createPoolDetailsHandler } from "./endpoints/poolDetails";
import { createProtocolStatsHandler } from "./endpoints/protocolStats";
import { createExploreStatsHandler } from "./endpoints/exploreStats";
import {
  createBridgeSwapHandler,
  createBulkBridgeSwapHandler,
  createGetBridgeSwapByIdHandler,
  createGetBridgeSwapsByUserHandler,
} from "./endpoints/bridgeSwap";
import {
  createNonceHandler,
  createVerifyHandler,
  createMeHandler,
} from "./endpoints/auth";
import { requireAuth } from "./middleware/auth";

// Initialize logger
const logger = Logger.createLogger({
  name: "juiceswap-routing-api",
  level: (process.env.LOG_LEVEL as Logger.LogLevel) || "info",
  serializers: Logger.stdSerializers,
});

async function bootstrap() {
  logger.info("Starting JuiceSwap Clean Routing API...");

  // Initialize quote cache with logger
  quoteCache.setLogger(logger);

  // Initialize portfolio cache with logger
  portfolioCache.setLogger(logger);

  // Initialize launchpad token service with logger
  setLaunchpadTokenServiceLogger(logger);

  // Initialize RPC providers
  const providers = initializeProviders(logger);

  // Verify provider connectivity
  await verifyProviders(providers, logger);

  // Initialize router service with Ponder integration
  const routerService = await RouterService.create(providers, logger);

  // Initialize JuiceGateway service for JUSD/JUICE/SUSD token routing
  // SUSD is handled via Gateway's registerBridgedToken() mechanism
  const juiceGatewayService = new JuiceGatewayService(providers, logger);

  // Initialize svJUSD price service for share price caching
  const svJusdPriceService = new SvJusdPriceService(providers, logger);

  // Initialize GraphQL resolvers
  initializeResolvers(routerService, logger);

  // Create Express app
  const app = express();

  // Trust proxy for rate limiting
  app.set("trust proxy", true);

  // Body parsing middleware
  app.use(express.json({ limit: "1mb" }));

  // Security headers with Helmet (configured for API use)
  app.use(
    helmet({
      contentSecurityPolicy: false, // Disable CSP for API
      crossOriginEmbedderPolicy: false, // Allow embedding (for Swagger UI)
    }),
  );

  // CORS configuration
  const corsOrigins = process.env.CORS_ORIGINS?.split(",").map((o) =>
    o.trim(),
  ) || [
    "http://localhost:3000",
    "http://localhost:3001",
    "http://localhost:3002",
    "https://bapp.juiceswap.com",
    "https://dev.bapp.juiceswap.com",
  ];

  app.use((req, res, next) => {
    const origin = req.headers.origin;

    // Check if origin is allowed
    if (origin) {
      // Check exact match
      if (corsOrigins.includes(origin)) {
        res.header("Access-Control-Allow-Origin", origin);
      }
      // Check if it's a juiceswap.com subdomain (supports multi-level subdomains)
      else if (/^https?:\/\/([\w-]+\.)*juiceswap\.com(:\d+)?$/.test(origin)) {
        res.header("Access-Control-Allow-Origin", origin);
      }
    } else {
      // No origin header (e.g., server-to-server request)
      res.header("Access-Control-Allow-Origin", corsOrigins[0]);
    }

    res.header(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, x-request-source, x-app-version, x-api-key, x-universal-router-version, x-viem-provider-enabled, x-uniquote-enabled",
    );
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

    if (req.method === "OPTIONS") {
      res.sendStatus(200);
    } else {
      next();
    }
  });

  // Request logging middleware
  app.use((req, res, next) => {
    const requestId =
      (req.headers["x-request-id"] as string) || `${req.method}-${Date.now()}`;
    req.headers["x-request-id"] = requestId;

    logger.debug(
      {
        requestId,
        method: req.method,
        path: req.path,
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      },
      "Incoming request",
    );

    // Log response
    const originalSend = res.send;
    res.send = function (data) {
      logger.debug(
        {
          requestId,
          statusCode: res.statusCode,
          responseTime: res.getHeader("X-Response-Time"),
        },
        "Request completed",
      );
      return originalSend.call(this, data);
    };

    next();
  });

  // Create endpoint handlers
  const handleQuote = createQuoteHandler(
    routerService,
    logger,
    juiceGatewayService,
  );
  const handleSwap = createSwapHandler(
    routerService,
    logger,
    juiceGatewayService,
  );
  const handleSwappableTokens = createSwappableTokensHandler(logger);
  const handleSwapApprove = createSwapApproveHandler(routerService, logger);
  const handleSwaps = createSwapsHandler(routerService, logger);
  const handleLpApprove = createLpApproveHandler(
    routerService,
    logger,
    juiceGatewayService,
  );
  const handleLpCreate = createLpCreateHandler(
    routerService,
    logger,
    juiceGatewayService,
  );
  const handleLpIncrease = createLpIncreaseHandler(
    routerService,
    logger,
    juiceGatewayService,
  );
  const handleLpDecrease = createLpDecreaseHandler(
    routerService,
    logger,
    juiceGatewayService,
  );
  const handleLpClaim = createLpClaimHandler(
    routerService,
    logger,
    juiceGatewayService,
  );
  const handlePortfolio = createPortfolioHandler(providers, logger);

  // User metrics endpoint handlers
  const handleTotalAddressesWithIp = createTotalAddressesWithIpHandler(logger);
  const handleUniqueIpHashes = createUniqueIpHashesHandler(logger);

  // Launchpad endpoint handlers
  const handleLaunchpadTokens = createLaunchpadTokensHandler(logger);
  const handleLaunchpadToken = createLaunchpadTokenHandler(logger);
  const handleLaunchpadTokenTrades = createLaunchpadTokenTradesHandler(logger);
  const handleLaunchpadStats = createLaunchpadStatsHandler(logger);
  const handleLaunchpadRecentTrades =
    createLaunchpadRecentTradesHandler(logger);
  const handleUploadImage = createUploadImageHandler(logger);
  const handleUploadMetadata = createUploadMetadataHandler(logger);

  // Campaign endpoint handlers
  const handleTwitterStart = createTwitterStartHandler(logger);
  const handleTwitterCallback = createTwitterCallbackHandler(logger);
  const handleTwitterStatus = createTwitterStatusHandler(logger);
  const handleDiscordStart = createDiscordStartHandler(logger);
  const handleDiscordCallback = createDiscordCallbackHandler(logger);
  const handleDiscordStatus = createDiscordStatusHandler(logger);
  const handleBAppsStatus = createBAppsStatusHandler(logger);
  const handleNFTSignature = createNFTSignatureHandler(logger);
  const handleLightningInvoice = createLightningInvoiceHandler(logger);
  const handleValidateLightningAddress =
    createValidateLightningAddressHandler(logger);
  const handlePositionInfo = createPositionInfoHandler(routerService, logger);
  const handlePositionsOwner = createPositionsOwnerHandler(
    routerService,
    logger,
  );
  const handlePoolDetails = createPoolDetailsHandler(providers, logger);
  const handleProtocolStats = createProtocolStatsHandler(providers, logger);
  const handleExploreStats = createExploreStatsHandler(providers, logger);
  const handleSvJusdSharePrice = createSvJusdSharePriceHandler(
    svJusdPriceService,
    logger,
  );
  const handleCreateBridgeSwap = createBridgeSwapHandler(logger);
  const handleBulkCreateBridgeSwap = createBulkBridgeSwapHandler(logger);
  const handleGetBridgeSwapById = createGetBridgeSwapByIdHandler(logger);
  const handleGetBridgeSwapsByUser = createGetBridgeSwapsByUserHandler(logger);

  // Auth endpoint handlers
  const handleNonce = createNonceHandler(logger);
  const handleVerify = createVerifyHandler(logger);

  // Auth routes (public)
  // To protect a route, add `requireAuth` to the chain:
  //   app.post("/v1/protected", generalLimiter, requireAuth, validateBody(...), handler);
  app.get("/v1/auth/nonce", generalLimiter, handleNonce);
  app.post(
    "/v1/auth/verify",
    generalLimiter,
    validateBody(AuthVerifyRequestSchema, logger),
    handleVerify,
  );
  app.get("/v1/auth/me", generalLimiter, requireAuth, createMeHandler());

  // API Routes with validation
  app.post(
    "/v1/quote",
    quoteLimiter,
    validateBody(QuoteRequestSchema, logger),
    handleQuote,
  );
  app.post(
    "/v1/swap",
    generalLimiter,
    validateBody(SwapRequestSchema, logger),
    handleSwap,
  );
  app.post(
    "/v1/swap/approve",
    generalLimiter,
    validateBody(SwapApproveRequestSchema, logger),
    handleSwapApprove,
  );

  // Swappable tokens endpoint (returns supported tokens)
  app.get(
    "/v1/swappable_tokens",
    validateQuery(SwappableTokensQuerySchema, logger),
    handleSwappableTokens,
  );

  // Portfolio endpoint (returns wallet token balances)
  app.get(
    "/v1/portfolio/:address",
    generalLimiter,
    validateQuery(PortfolioQuerySchema, logger),
    handlePortfolio,
  );

  // Position info endpoint (returns liquidity position information)
  app.get(
    "/v1/positions/:tokenId",
    generalLimiter,
    validateQuery(PositionInfoQuerySchema, logger),
    handlePositionInfo,
  );

  // Positions by owner endpoint (returns all positions for an owner with live on-chain data)
  app.post(
    "/v1/positions/owner",
    generalLimiter,
    validateBody(PositionsOwnerRequestSchema, logger),
    handlePositionsOwner,
  );

  // Pool details endpoint
  app.post(
    "/v1/pools/v3/details",
    generalLimiter,
    validateBody(PoolDetailsRequestSchema, logger),
    handlePoolDetails,
  );

  // Protocol stats endpoint
  app.post(
    "/v1/protocol/stats",
    generalLimiter,
    validateBody(ProtocolStatsRequestSchema, logger),
    handleProtocolStats,
  );

  // Explore stats endpoint (enriched with USD prices, TVL, volumes)
  app.get("/v1/explore/stats", quoteLimiter, handleExploreStats);

  // LP endpoints
  app.post(
    "/v1/lp/approve",
    generalLimiter,
    validateBody(LpApproveRequestSchema, logger),
    handleLpApprove,
  );
  app.post(
    "/v1/lp/create",
    generalLimiter,
    validateBody(LpCreateRequestSchema, logger),
    handleLpCreate,
  );
  app.post(
    "/v1/lp/increase",
    generalLimiter,
    validateBody(LpIncreaseRequestSchema, logger),
    handleLpIncrease,
  );
  app.post(
    "/v1/lp/decrease",
    generalLimiter,
    validateBody(LpDecreaseRequestSchema, logger),
    handleLpDecrease,
  );
  app.post(
    "/v1/lp/claim",
    generalLimiter,
    validateBody(LpClaimRequestSchema, logger),
    handleLpClaim,
  );

  // svJUSD share price endpoint (for frontend price calculations)
  app.get("/v1/svjusd/sharePrice", generalLimiter, handleSvJusdSharePrice);

  // Lightning invoice endpoint
  app.post(
    "/v1/lightning/invoice",
    generalLimiter,
    validateBody(LightningInvoiceRequestSchema, logger),
    handleLightningInvoice,
  );
  app.post(
    "/v1/lightning/validate",
    generalLimiter,
    validateBody(LightningAddressRequestSchema, logger),
    handleValidateLightningAddress,
  );

  // Swaps transaction status endpoint
  app.get("/v1/swaps", validateQuery(SwapsQuerySchema, logger), handleSwaps);

  // User metrics endpoints
  app.get("/v1/metrics/users/total-with-ip", handleTotalAddressesWithIp);
  app.get("/v1/metrics/users/unique-ips", handleUniqueIpHashes);

  // Launchpad endpoints (proxies to Ponder)
  app.get(
    "/v1/launchpad/tokens",
    generalLimiter,
    validateQuery(LaunchpadTokensQuerySchema, logger),
    handleLaunchpadTokens,
  );
  app.get("/v1/launchpad/token/:address", generalLimiter, handleLaunchpadToken);
  app.get(
    "/v1/launchpad/token/:address/trades",
    generalLimiter,
    validateQuery(LaunchpadTradesQuerySchema, logger),
    handleLaunchpadTokenTrades,
  );
  app.get("/v1/launchpad/stats", generalLimiter, handleLaunchpadStats);
  app.get(
    "/v1/launchpad/recent-trades",
    generalLimiter,
    validateQuery(LaunchpadRecentTradesQuerySchema, logger),
    handleLaunchpadRecentTrades,
  );

  // Launchpad metadata upload endpoints (Pinata IPFS)
  app.post("/v1/launchpad/upload-image", generalLimiter, handleUploadImage);
  app.post(
    "/v1/launchpad/upload-metadata",
    generalLimiter,
    validateBody(LaunchpadUploadMetadataSchema, logger),
    handleUploadMetadata,
  );

  // Campaign endpoints - Twitter OAuth
  app.get(
    "/v1/campaigns/first-squeezer/twitter/start",
    generalLimiter,
    handleTwitterStart,
  );
  app.get(
    "/v1/campaigns/first-squeezer/twitter/callback",
    generalLimiter,
    handleTwitterCallback,
  );
  app.get(
    "/v1/campaigns/first-squeezer/twitter/status",
    generalLimiter,
    handleTwitterStatus,
  );

  // Campaign endpoints - Discord OAuth
  app.get(
    "/v1/campaigns/first-squeezer/discord/start",
    generalLimiter,
    handleDiscordStart,
  );
  app.get(
    "/v1/campaigns/first-squeezer/discord/callback",
    generalLimiter,
    handleDiscordCallback,
  );
  app.get(
    "/v1/campaigns/first-squeezer/discord/status",
    generalLimiter,
    handleDiscordStatus,
  );

  // Campaign endpoints - bApps Verification
  app.get(
    "/v1/campaigns/first-squeezer/bapps/status",
    generalLimiter,
    handleBAppsStatus,
  );

  // Campaign endpoints - NFT Claiming
  app.get(
    "/v1/campaigns/first-squeezer/nft/signature",
    generalLimiter,
    handleNFTSignature,
  );

  // Bridge Swap endpoints
  app.post(
    "/v1/bridge-swap",
    generalLimiter,
    requireAuth,
    validateBody(CreateBridgeSwapSchema, logger),
    handleCreateBridgeSwap,
  );

  app.post(
    "/v1/bridge-swap/bulk",
    generalLimiter,
    requireAuth,
    validateBody(BulkCreateBridgeSwapSchema, logger),
    handleBulkCreateBridgeSwap,
  );

  app.get(
    "/v1/bridge-swap/user",
    generalLimiter,
    requireAuth,
    validateQuery(GetBridgeSwapsByUserQuerySchema, logger),
    handleGetBridgeSwapsByUser,
  );

  app.get(
    "/v1/bridge-swap/:id",
    generalLimiter,
    requireAuth,
    handleGetBridgeSwapById,
  );

  // GraphQL endpoint
  app.use("/v1/graphql", await getApolloMiddleware(logger));

  // API Documentation (Swagger UI)
  // Type assertions needed due to @types/swagger-ui-express bundling its own @types/express
  app.use(
    "/swagger",
    swaggerUi.serve as any,
    swaggerUi.setup(swaggerSpec, {
      customCss: ".swagger-ui .topbar { display: none }",
      customSiteTitle: "JuiceSwap API Documentation",
    }) as any,
  );

  // Health check endpoints
  app.get("/healthz", (_req: Request, res: Response) => {
    res.status(200).send("ok");
  });

  app.get("/readyz", async (_req: Request, res: Response) => {
    // Check if at least one provider is working
    const chains = routerService.getSupportedChains();
    if (chains.length > 0) {
      res.status(200).send("ready");
    } else {
      res.status(503).send("not ready");
    }
  });

  // Version endpoint
  app.get("/version", (_req: Request, res: Response) => {
    res.json({
      name: packageJson.name,
      version: packageJson.version,
      node: process.version,
      environment: process.env.NODE_ENV || "development",
    });
  });

  // Metrics endpoint (basic)
  app.get("/metrics", async (_req: Request, res: Response) => {
    const userCount = await prisma.user.count().catch((error) => {
      logger.warn({ error }, "Failed to fetch user count for metrics");
      return -1;
    });

    const trackedUsers = await prisma.user
      .count({
        where: { ipAddressHash: { not: null } },
      })
      .catch((error) => {
        logger.warn({ error }, "Failed to fetch tracked users for metrics");
        return -1;
      });

    const uniqueIpResult = await prisma.user
      .groupBy({
        by: ["ipAddressHash"],
        where: { ipAddressHash: { not: null } },
        _count: true,
      })
      .catch((error) => {
        logger.warn({ error }, "Failed to fetch unique IPs for metrics");
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
    logger.warn({ path: req.path, method: req.method }, "Route not found");
    res.status(404).json({
      error: "Not found",
      detail: `The endpoint ${req.method} ${req.path} does not exist`,
    });
  });

  // Error handler
  app.use((err: any, req: Request, res: Response, _next: any) => {
    logger.error({ error: err, path: req.path }, "Unhandled error");
    res.status(500).json({
      error: "Internal server error",
      detail:
        process.env.NODE_ENV === "development"
          ? err.message
          : "An error occurred",
    });
  });

  // Start server
  const port = parseInt(process.env.PORT || "3000");
  const server = app.listen(port, "0.0.0.0", () => {
    logger.info({ port }, `JuiceSwap Routing API listening on port ${port}`);
    logger.info(`Environment: ${process.env.NODE_ENV || "development"}`);
    logger.info(
      `Supported chains: ${routerService.getSupportedChains().join(", ")}`,
    );
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, starting graceful shutdown...`);

    server.close(() => {
      logger.info("HTTP server closed");
      process.exit(0);
    });

    // Force shutdown after 10 seconds
    setTimeout(() => {
      logger.error("Forced shutdown after timeout");
      process.exit(1);
    }, 10000);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// Start the application
bootstrap().catch((error) => {
  logger.fatal(
    {
      error: error.message,
      stack: error.stack,
      name: error.name,
    },
    "Failed to start application",
  );
  process.exit(1);
});
