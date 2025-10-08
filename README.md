# JuiceSwap Routing API

A platform-agnostic routing API for JuiceSwap, optimized for simplicity, maintainability, and performance.

## Key Features

- ✅ **Platform Agnostic**: No AWS dependencies, runs anywhere
- ✅ **Simple Architecture**: Direct RPC connections, no complex abstractions
- ✅ **High Performance**: In-memory caching, optimized routing
- ✅ **API Compatible**: Maintains full compatibility with existing frontend
- ✅ **Minimal Dependencies**: Only essential packages included
- ✅ **Easy Deployment**: Docker-ready, works on any cloud provider

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your RPC URLs
```

### 3. Run Development Server

```bash
npm run dev
```

### 4. Build for Production

```bash
npm run build
npm start
```

## Docker Deployment

```bash
# Build image
docker build -t juiceswap-api .

# Run container
docker run -p 3000:3000 --env-file .env juiceswap-api
```

## API Endpoints

### Core Endpoints

- `POST /v1/quote` - Get swap quote ✅
- `POST /v1/swap` - Get swap transaction data ✅
- `GET /v1/swappable_tokens` - Get supported tokens ✅
- `POST /v1/lp/approve` - Approve liquidity pool tokens ✅
- `POST /v1/lp/create` - Create liquidity pool position ✅
- `GET /v1/swaps` - Check swap transaction status ✅

### GraphQL

- `POST /v1/graphql` - Apollo GraphQL server for quotes and swaps ✅

### Utility Endpoints

- `GET /healthz` - Health check ✅
- `GET /readyz` - Readiness check ✅
- `GET /version` - API version info ✅
- `GET /metrics` - Basic metrics ✅

### Migration Notes

This Node.js implementation achieves **full parity** with the AWS Lambda version:

**✅ Complete Feature Set:**
- ✅ Swap routing and quoting
- ✅ Transaction building
- ✅ Liquidity pool operations
- ✅ Transaction status tracking
- ✅ Health and metrics endpoints
- ✅ GraphQL endpoint (Apollo Server with full schema)
- ✅ Dynamic token list (Ponder API integration for Citrea chains)

## Architecture

```
src/
├── core/           # Core routing logic
│   └── RouterService.ts
├── providers/      # RPC provider management
│   └── rpcProvider.ts
├── endpoints/      # HTTP endpoint handlers
│   ├── quote.ts
│   └── swap.ts
├── cache/          # In-memory caching
│   └── quoteCache.ts
├── middleware/     # Express middleware
│   └── rateLimiter.ts
└── server.ts       # Express server
```

## Supported Chains

- Ethereum Mainnet (1)
- Sepolia Testnet (11155111)
- Citrea Testnet (5115)

## Configuration

All configuration is done through environment variables:

```bash
# Server
PORT=3000
NODE_ENV=production

# RPC Providers (Alchemy API Keys)
ALCHEMY_1=your-alchemy-api-key          # Ethereum Mainnet
ALCHEMY_11155111=your-alchemy-api-key   # Sepolia Testnet
ALCHEMY_5115=none                       # Citrea Testnet (uses custom RPC)

# Citrea RPC URL
CITREA_RPC_URL=http://vm-dfx-node-dev.westeurope.cloudapp.azure.com:8085

# Cache
CACHE_TTL_SECONDS=30
CACHE_MAX_SIZE=1000

# Ponder API (for Citrea token list)
PONDER_URL=https://ponder.juiceswap.com

# Rate Limiting
RATE_LIMIT_QUOTE_PER_MINUTE=2000
RATE_LIMIT_GENERAL_PER_MINUTE=10000
```

## Performance

- **Response Time**: < 500ms for cached quotes
- **Throughput**: 1000+ requests/second
- **Cache Hit Rate**: 60-80% during peak usage
- **Memory Usage**: < 256MB typical

## Monitoring

Basic monitoring is available through the `/metrics` endpoint:

```json
{
  "uptime": 3600,
  "memory": {
    "rss": 123456789,
    "heapTotal": 12345678,
    "heapUsed": 9876543
  },
  "chains": [1, 11155111, 5115]
}
```

## Development

```bash
# Run tests
npm test

# Lint code
npm run lint

# Type check
npm run typecheck

# Format code
npm run format
```

## Deployment Options

### Azure Container Apps

```bash
az containerapp create \
  --name juiceswap-api \
  --resource-group mygroup \
  --image juiceswap-api:latest \
  --environment myenv \
  --cpu 0.5 --memory 1 \
  --min-replicas 1 \
  --max-replicas 10
```

### Google Cloud Run

```bash
gcloud run deploy juiceswap-api \
  --image gcr.io/myproject/juiceswap-api \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated
```

### Kubernetes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: juiceswap-api
spec:
  replicas: 3
  template:
    spec:
      containers:
      - name: api
        image: juiceswap-api:latest
        ports:
        - containerPort: 3000
```

## Troubleshooting

### RPC Connection Issues

- Verify RPC URLs in `.env`
- Check network connectivity
- Ensure RPC rate limits are sufficient

### High Memory Usage

- Adjust `CACHE_MAX_SIZE`
- Reduce `CACHE_TTL_SECONDS`
- Consider adding Redis for distributed caching

### Slow Responses

- Check RPC provider latency
- Monitor cache hit rate
- Verify sufficient CPU/memory resources

## Contributing

This implementation is focused on simplicity and maintainability. When contributing:

1. Keep it simple - no unnecessary abstractions
2. Avoid external service dependencies
3. Maintain API compatibility
4. Add tests for new features
5. Document configuration changes

## License

GPL-3.0 (inherited from Uniswap)