# Launchpad Token Charts Analysis

Date: 2026-05-31
Repository: `JuiceSwap-api`
Branch prepared: `joshua/launchpad-token-candles`
Implementation status: Phase 1 API endpoint implemented in this branch as
`GET /v1/launchpad/token/:address/candles`.

## Scope

This document reviews how to add Pump.fun-style charts for every JuiceSwap
Launchpad token. It focuses on the API/indexer boundary because the frontend
chart is straightforward once the backend exposes stable OHLCV data.

The analysis uses:

- Local `JuiceSwap-api` source.
- Live Ponder API/schema checks against `https://ponder.juiceswap.com`.
- Public `@juiceswapxyz/launchpad@3.0.0` package metadata and README.
- Public JuiceSwap docs and TradingView Lightweight Charts docs.

## Executive Decision

Best approach: add an API-owned Launchpad candle endpoint backed by Ponder
Launchpad trade data, with the API responsible for bucketing, price math,
pagination, and cache control. In this branch the endpoint is intentionally
Phase 1 only: it returns bonding-curve execution-price candles from
`launchpadTrades`. For a graduated token, that means pre-graduation
bonding-curve history plus a graduation marker, not fabricated V2 OHLC.

Recommended endpoint:

```text
GET /v1/launchpad/token/:address/candles
```

Recommended query:

```text
chainId=4114
interval=1m|5m|15m|1h|4h|1d
from=epoch_seconds
to=epoch_seconds
limit=1000
currency=base
fill=none|last
```

Recommended response:

```json
{
  "token": {
    "address": "0x...",
    "chainId": 4114,
    "name": "Example",
    "symbol": "EXM",
    "graduated": false,
    "canGraduate": false,
    "progress": 1234,
    "v2Pair": null
  },
  "quote": {
    "address": "0x0987D3720D38847ac6dBB9D025B9dE892a3CA35C",
    "symbol": "JUSD",
    "decimals": 18
  },
  "source": "bonding_curve",
  "priceBasis": "execution_price",
  "candles": [
    {
      "time": 1780167060,
      "open": 0.00000415,
      "high": 0.00000415,
      "low": 0.00000415,
      "close": 0.00000415,
      "volumeBase": 0.9801,
      "volumeToken": 236008.07822279099,
      "tradeCount": 1
    }
  ],
  "latest": {
    "price": 0.00000415,
    "timestamp": 1780167091
  }
}
```

Why this is the best fit:

- The existing launchpad REST endpoints only return lists, token details, and
  raw paginated trades. The frontend should not have to page all trades and
  reproduce price math.
- Ponder already exposes enough data for a useful pre-graduation chart.
- Post-graduation charts need more indexer data than the current public schema
  exposes if we want correct historical OHLC, not just volume bars.
- An API endpoint lets the frontend use a normal chart library and stay
  independent from Ponder schema details.

## API State Before This Branch

Before this branch, the API had these Launchpad routes:

- `GET /v1/launchpad/tokens`
- `GET /v1/launchpad/token/:address`
- `GET /v1/launchpad/token/:address/trades`
- `GET /v1/launchpad/stats`
- `GET /v1/launchpad/recent-trades`
- metadata upload endpoints

The handlers in `src/endpoints/launchpad.ts` are thin Ponder REST proxies. They
validate addresses for token detail/trades and forward query parameters to
Ponder. Before this branch, the route registration in `src/server.ts` and the
validation schemas supported token list/trades/recent-trades only. This branch
adds the token-candle endpoint listed above.

Existing pool chart endpoints are useful references:

- `GET /v1/pools/:address/price-history`
- `GET /v1/pools/:address/volume-history`
- `GET /v1/pools/:address/transactions`

The V3 pool price endpoint reads `poolActivitys` from Ponder, converts
`sqrtPriceX96` snapshots into price points, resamples by duration, and caches
for 30 seconds. The V3 pool volume endpoint reads `poolStats` buckets and also
caches for 30 seconds. The Launchpad candle endpoint should reuse those local
patterns: `ResponseCache`, `PonderClient`, direct GraphQL queries, explicit
duration mapping, and capped output.

## Launchpad Contract Facts

The public package `@juiceswapxyz/launchpad@3.0.0` describes the launchpad as a
constant-product bonding curve with automatic JuiceSwap V2 graduation. All
tokens trade against JUSD, graduation creates TOKEN/JUSD V2 pairs, and LP
tokens are burned to `0xdead`.

Important package/contract facts:

- `TokenFactory` emits `TokenCreated`.
- `BondingCurveToken` emits `Buy`, `Sell`, `ReadyForGraduation`, and
  `Graduated`.
- `Buy` includes buyer, base input, token output, and the new virtual reserves.
- `Sell` includes seller, token input, base output, and the new virtual
  reserves.
- `Graduated` includes the V2 pair, liquidity locked, and protocol fees.
- The launchpad constants are fixed around 1B total token supply, 793.1M real
  tokens sold on curve, 206.9M reserved for V2 liquidity, and 1% fee.
- Mainnet launchpad factory in the package is
  `0xF5E06d37091a252A3Ae6BFd575D97635625028b9`.

This is important for charts because the contract events contain more useful
price-state information than the current `launchpadTrade` Ponder table exposes.

## Live Ponder Schema Findings

Live Ponder schema exposes these relevant query roots:

- `launchpadToken`
- `launchpadTokens`
- `launchpadTrade`
- `launchpadTrades`
- `graduatedV2Pool`
- `graduatedV2Pools`
- `v2PoolStat`
- `v2PoolStats`

Live `launchpadToken` fields include:

- `address`
- `chainId`
- `name`
- `symbol`
- `creator`
- `baseAsset`
- `metadataURI`
- `createdAt`
- `createdAtBlock`
- `txHash`
- `graduated`
- `canGraduate`
- `v2Pair`
- `graduatedAt`
- `totalBuys`
- `totalSells`
- `totalVolumeBase`
- `lastTradeAt`
- `progress`

Live `launchpadTrade` fields include:

- `id`
- `tokenAddress`
- `chainId`
- `trader`
- `isBuy`
- `baseAmount`
- `tokenAmount`
- `timestamp`
- `blockNumber`
- `txHash`

Live `graduatedV2Pool` fields include:

- `pairAddress`
- `chainId`
- `token0`
- `token1`
- `launchpadTokenAddress`
- `createdAt`
- `createdAtBlock`
- `txHash`
- `totalSwaps`

Live `v2PoolStat` fields include:

- `poolAddress`
- `chainId`
- `timestamp`
- `txCount`
- `volume0`
- `volume1`
- `type`

Mainnet live data currently confirms Launchpad data is populated: the Ponder
list endpoint returned 118 launchpad tokens for chain `4114`, and
`graduatedV2Pools` returned graduated TOKEN/JUSD pairs. The live data also
confirms that `v2PoolStats` currently gives volume buckets but not historical
price or swap-side details.

## Data Adequacy

### Pre-graduation bonding curve tokens

Current data is enough for an MVP candlestick chart:

```text
executionPriceBasePerToken = baseAmount / tokenAmount
```

Both Launchpad token and JUSD use 18 decimals, but the service should still
keep decimals explicit so the code remains correct if the base asset changes.

For each bucket:

- `open`: first trade execution price in the bucket.
- `high`: max trade execution price.
- `low`: min trade execution price.
- `close`: last trade execution price.
- `volumeBase`: sum of `baseAmount`.
- `volumeToken`: sum of `tokenAmount`.
- `tradeCount`: number of trades.

Limitations:

- This is execution-price OHLC, not exact post-trade spot-price OHLC.
- Large bonding-curve trades can have meaningful average-vs-close difference.
- Buy and sell amounts include fee effects differently: buy `baseAmount` is
  gross user input, sell `baseAmount` is net output.

Better chart data requires extending Ponder `launchpadTrade` to store the
virtual reserves emitted in `Buy` and `Sell`. With post-trade reserves, the API
can compute a reserve-price close:

```text
spotPriceBasePerToken = virtualBaseReserves / virtualTokenReserves
```

That produces a chart closer to a DEX "mark price", while still exposing volume
from actual trades.

### Post-graduation V2 tokens

Current data is not enough for a full historical candlestick chart after
graduation.

What exists now:

- `graduatedV2Pools` maps launchpad token to V2 pair.
- `v2PoolStats` gives bucketed volume and tx count.
- On-chain `getReserves()` can give current spot price.

What is missing for historical OHLC:

- Per-swap V2 event records for graduated pairs.
- Amount direction, e.g. `amount0In`, `amount1In`, `amount0Out`,
  `amount1Out`.
- Pair reserves after swap, or at least a post-swap price snapshot.

Recommendation: extend the Ponder indexer with a table like
`graduatedV2Swap`:

```text
id
chainId
pairAddress
launchpadTokenAddress
trader or sender
recipient
token0
token1
amount0In
amount1In
amount0Out
amount1Out
reserve0After
reserve1After
timestamp
blockNumber
txHash
logIndex
```

Then API can compute post-graduation candles using the same bucket logic as
bonding-curve trades.

Future V2/indexer-extension option if Ponder indexer changes are not
immediately available:

- Show bonding-curve candles up to graduation.
- Show current V2 price from `getReserves()`.
- Show post-graduation volume bars from `v2PoolStats`.
- Mark the chart response as `source: "partial_post_graduation"`.

Do not fake historical V2 OHLC from `v2PoolStats`; volume-only buckets do not
contain price. Phase 1 in this branch does not emit
`partial_post_graduation`; it only emits `bonding_curve` or
`bonding_curve_pre_graduation`.

## Proposed Backend Architecture

Add files:

```text
src/endpoints/launchpadCandles.ts
src/services/LaunchpadChartService.ts
```

Extend files:

```text
src/validation/schemas.ts
src/server.ts
src/swagger/schemas.ts
src/endpoints/launchpad.ts or imports next to it
```

Validation schema:

```ts
export const LaunchpadCandlesQuerySchema = z.object({
  chainId: z
    .string()
    .optional()
    .default("4114")
    .transform(Number)
    .pipe(ChainIdSchema),
  interval: z.enum(["1m", "5m", "15m", "1h", "4h", "1d"]).default("5m"),
  from: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : undefined)),
  to: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : undefined)),
  limit: z
    .string()
    .optional()
    .default("1000")
    .transform(Number)
    .pipe(z.number().int().min(1).max(1500)),
  currency: z.literal("base").default("base"),
  fill: z.enum(["none", "last"]).optional().default("none"),
});
```

Add a token address params schema instead of reusing a pool-specific name:

```ts
export const LaunchpadTokenAddressParamsSchema = z.object({
  address: AddressSchema,
});
```

Endpoint route:

```ts
app.get(
  "/v1/launchpad/token/:address/candles",
  generalLimiter,
  validateParams(LaunchpadTokenAddressParamsSchema, logger),
  validateQuery(LaunchpadCandlesQuerySchema, logger),
  handleLaunchpadCandles,
);
```

Implementation notes:

- Use `getAddress(req.params.address)` for checksum validation.
- Use `ResponseCache` with a short TTL: 5 to 15 seconds for `1m`/`5m`, 30 to
  60 seconds for larger intervals.
- Use GraphQL directly through `PonderClient.query`, not the Ponder REST trade
  endpoint, because GraphQL supports deterministic `orderBy: "timestamp"` and
  range filters.
- For range queries, page Ponder's GraphQL connection locally with `after` and
  `pageInfo`, using `limit: 1000` per page and a safety cap on total pages.
- Resolve `from` to the containing bucket start and cap the resolved range by
  `limit` before querying Ponder, so the first returned bucket is not missing
  earlier trades from the same interval.
- Use a cache key that includes `chainId`, token address, interval, range,
  currency, fill mode, and optional trader marker wallet.
- Return a 404 only if the token does not exist. Return an empty candle list for
  known tokens with no trade history. With `fill=last`, seed the chart from the
  last trade before `from` when one exists.
- Treat raw Ponder amount fields as strings, validate them during conversion,
  and convert with `ethers.utils.formatUnits`/`parseFloat` before response-side
  price and volume math. OHLC and volume fields remain JSON numbers.

## Candle Math

Use helper functions rather than embedding math in the endpoint.

```ts
function toDecimal(raw: string, decimals: number): number;
function executionPriceBasePerToken(
  baseRaw: string,
  tokenRaw: string,
): number | null;
function bucketStart(timestamp: number, intervalSec: number): number;
function addTradeToBucket(bucket, trade): void;
```

For bonding curve:

```text
price = decimal(baseAmount, baseDecimals) / decimal(tokenAmount, tokenDecimals)
```

For V2 swap records after the indexer is extended:

```text
if launchpad token is token0 and JUSD is token1:
  tokenAmount = abs(amount0In - amount0Out)
  baseAmount = abs(amount1In - amount1Out)
  reservePrice = reserve1After / reserve0After

if launchpad token is token1 and JUSD is token0:
  tokenAmount = abs(amount1In - amount1Out)
  baseAmount = abs(amount0In - amount0Out)
  reservePrice = reserve0After / reserve1After
```

For a later USD output:

- JUSD can be treated as USD 1.0 for Launchpad chart display, matching the
  existing Explore assumptions.
- If the base asset becomes non-stable later, use `PriceService` and expose
  `currency=base` as the canonical source.

## Frontend Recommendation

Use `lightweight-charts` for the token chart UI.

Reasons:

- It is purpose-built for financial charts and candlesticks.
- It supports streaming updates.
- It is small and open source.
- It accepts normal OHLC data; no TradingView market-data integration is
  required.

Frontend should not use the current `/trades` endpoint as the primary chart
data source. It can use `/trades` for the live trade table. The chart should
consume `/candles`.

Expected frontend panels per token:

- Candlestick price chart.
- Volume histogram below the candles.
- Recent trades table.
- Current price, 1h/24h change, market cap/FDV, volume, buy/sell counts.
- Bonding-curve progress before graduation.
- Graduation marker and V2 pair link after graduation.

Realtime behavior:

- Poll `/candles` every 5 to 10 seconds for the active token page.
- Poll `/recent-trades` or token `/trades` separately for the trade tape.
- Later, add a websocket/SSE endpoint only if polling becomes too slow or too
  expensive.

## Pump.fun-Like Behavior Map

For each token page:

- Before graduation:
  - Price chart from bonding curve trades.
  - Progress from `launchpadToken.progress`.
  - Trade tape from `launchpadTrades`.
  - Latest price from last candle or on-chain `calculateBuy(1 JUSD)`.

- At graduation:
  - Add a visual marker on the chart at `graduatedAt`.
  - Freeze bonding-curve source after that timestamp.
  - Switch route/trading UI to V2 path.

- After graduation:
  - Current price from V2 reserves.
  - Historical candles from indexed V2 swaps once indexer data exists.
  - Volume bars from V2 stats if swap-level data is not yet indexed.

## Risk Review

High risk: post-graduation historical price is currently under-specified.
`v2PoolStats` has volume and tx count, not price. Building post-graduation OHLC
without V2 swap/reserve snapshots would be misleading.

Medium risk: current `launchpadTrade` schema lacks virtual reserves even though
contract events emit them. Execution-price candles are acceptable for MVP, but
reserve-price close is more accurate.

Medium risk: using frontend-side trade aggregation will create inconsistent
charts across clients, especially with pagination, time ranges, and sparse
trading.

Medium risk: low-volume tokens will have sparse candles. The API should expose
`fill=none|last` so the frontend can choose between honest gaps and continuous
visuals. In this branch `fill=last` also queries the last trade before the
visible range, so quiet tokens can still render a flat continuation instead of
an empty chart when prior price history exists.

Low risk: API route naming can be changed later, but `candles` is clearer than
overloading `price-history` because the UI needs OHLCV, not only line data.

## Implementation Phases

Phase 1: API MVP for bonding-curve Launchpad trades

- Add `LaunchpadCandlesQuerySchema`.
- Add `LaunchpadChartService`.
- Query `launchpadToken` and `launchpadTrades`.
- Compute execution-price OHLCV candles.
- For graduated tokens, keep `source=bonding_curve_pre_graduation`; do not fake
  V2 candles from `v2PoolStats`.
- Add route and Swagger docs.
- Unit test bucket math, decimal conversion, empty token behavior, and invalid
  query handling.

Phase 2: Better bonding-curve accuracy

- Extend Ponder `launchpadTrade` to store emitted virtual reserves.
- Add `priceBasis=spot_price` support.
- Keep `execution_price` available for compatibility.

Phase 3: Graduated V2 historical candles

- Extend Ponder with per-swap V2 data and post-swap reserves for
  `graduatedV2Pools`.
- Stitch pre-graduation and post-graduation candles in one response.
- Add a graduation marker array:

```json
{
  "markers": [{ "time": 1771073752, "type": "graduation", "pair": "0x..." }]
}
```

Phase 4: UI

- Install `lightweight-charts` in the actual bApp frontend repository.
- Build a token chart component fed by `/candles`.
- Add volume series, tooltip/crosshair, timeframe selector, and graduation
  marker.
- Use the existing trades endpoint for the live trade table.

## Final Recommendation

Build the backend candle endpoint first. Start with bonding-curve
execution-price candles because the current Ponder schema already supports it.
Do not present complete post-graduation OHLC until the indexer stores V2
swap/reserve snapshots. For the frontend, use TradingView Lightweight Charts
with API-provided OHLCV and keep raw trades separate.

This gives a Pump.fun-style chart quickly without baking fragile indexer logic
into the UI, and it leaves a clean path to exact post-graduation charts once the
Ponder layer is extended.

## Sources

- Local API launchpad proxy endpoints: `src/endpoints/launchpad.ts`.
- Local route registration: `src/server.ts`.
- Local launchpad validation schemas: `src/validation/schemas.ts`.
- Local V3 chart endpoint patterns: `src/endpoints/poolPriceHistory.ts` and
  `src/endpoints/poolVolumeHistory.ts`.
- Local Explore launchpad pricing logic: `src/services/ExploreStatsService.ts`.
- Live Ponder schema and sample data from `https://ponder.juiceswap.com/graphql`
  and launchpad REST endpoints.
- Public JuiceSwap docs: `https://docs.juiceswap.com/overview.html`.
- Public npm package: `@juiceswapxyz/launchpad@3.0.0`.
- TradingView Lightweight Charts docs: `https://tradingview.github.io/lightweight-charts/`.
