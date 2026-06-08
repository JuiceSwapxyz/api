import Logger from "bunyan";
import { ethers } from "ethers";
import { getPonderClient } from "./PonderClient";
import type { PonderClient } from "./PonderClient";
import { getChainContracts } from "../config/contracts";

export const LAUNCHPAD_INTERVAL_SECONDS = {
  "1m": 60,
  "5m": 5 * 60,
  "15m": 15 * 60,
  "1h": 60 * 60,
  "4h": 4 * 60 * 60,
  "1d": 24 * 60 * 60,
} as const;

export type LaunchpadChartInterval = keyof typeof LAUNCHPAD_INTERVAL_SECONDS;
export type LaunchpadChartCurrency = "base";
export type LaunchpadChartFill = "none" | "last";
export type LaunchpadChartSource =
  | "bonding_curve"
  | "bonding_curve_pre_graduation";

export interface LaunchpadCandlesRequest {
  address: string;
  chainId: number;
  interval: LaunchpadChartInterval;
  limit: number;
  currency: LaunchpadChartCurrency;
  fill: LaunchpadChartFill;
  from?: number;
  to?: number;
  trader?: string;
}

export interface LaunchpadCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeBase: number;
  volumeToken: number;
  tradeCount: number;
}

export interface LaunchpadUserTradeMarker {
  time: number;
  side: "buy" | "sell";
  price: number;
  baseAmount: number;
  tokenAmount: number;
  txHash: string;
  blockNumber: number;
}

interface LaunchpadTokenRecord {
  address: string;
  chainId: number;
  name: string;
  symbol: string;
  baseAsset: string;
  graduated: boolean;
  canGraduate: boolean;
  v2Pair: string | null;
  graduatedAt: string | null;
  totalBuys: number;
  totalSells: number;
  totalVolumeBase: string;
  lastTradeAt: string | null;
  progress: number;
}

export interface LaunchpadTradeRecord {
  id: string;
  tokenAddress: string;
  chainId: number;
  trader: string;
  isBuy: boolean;
  baseAmount: string;
  tokenAmount: string;
  timestamp: string;
  blockNumber: string;
  txHash: string;
}

export interface LaunchpadCandlesResponse {
  token: LaunchpadTokenRecord;
  quote: {
    address: string;
    symbol: string;
    decimals: number;
  };
  range: {
    from: number;
    to: number;
    interval: LaunchpadChartInterval;
    intervalSeconds: number;
    limit: number;
  };
  source: LaunchpadChartSource;
  priceBasis: "execution_price";
  currency: LaunchpadChartCurrency;
  candles: LaunchpadCandle[];
  latest: { price: number; timestamp: number } | null;
  markers: Array<{ time: number; type: "graduation"; pair: string | null }>;
  userTrades?: LaunchpadUserTradeMarker[];
}

export class LaunchpadTokenNotFoundError extends Error {
  constructor(address: string, chainId: number) {
    super(`Launchpad token not found: ${address} on chain ${chainId}`);
    this.name = "LaunchpadTokenNotFoundError";
  }
}

interface ResolvedRange {
  from: number;
  to: number;
  intervalSeconds: number;
}

interface CandleAccumulator extends LaunchpadCandle {
  lastTradeTimestamp: number;
}

const LAUNCHPAD_TRADE_PAGE_LIMIT = 1000;
const MAX_LAUNCHPAD_TRADE_PAGES = 500;

interface LaunchpadTradePageInfo {
  endCursor?: string | null;
  hasNextPage?: boolean | null;
}

interface LaunchpadTradesPage {
  items?: LaunchpadTradeRecord[];
  pageInfo?: LaunchpadTradePageInfo;
}

interface LaunchpadTradesPageResult {
  launchpadTrades?: LaunchpadTradesPage;
}

export class LaunchpadChartService {
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger.child({ service: "LaunchpadChartService" });
  }

  async getCandles(
    request: LaunchpadCandlesRequest,
  ): Promise<LaunchpadCandlesResponse> {
    const tokenAddress = request.address.toLowerCase();
    const traderAddress = request.trader?.toLowerCase();
    const range = resolveLaunchpadChartRange(request);
    const ponderClient = getPonderClient(this.logger);

    const [token, unsortedTrades, previousTrade] = await Promise.all([
      this.fetchLaunchpadToken(request.chainId, tokenAddress),
      fetchLaunchpadTradesForCandles({
        ponderClient,
        chainId: request.chainId,
        tokenAddress,
        from: range.from,
        to: range.to,
      }),
      request.fill === "last"
        ? this.fetchLatestLaunchpadTradeBefore(
            request.chainId,
            tokenAddress,
            range.from,
          )
        : Promise.resolve(null),
    ]);

    if (!token) {
      throw new LaunchpadTokenNotFoundError(request.address, request.chainId);
    }

    const trades = sortLaunchpadTrades(
      dedupeLaunchpadTradesById(unsortedTrades),
    );
    const previousClose = previousTrade
      ? executionPriceBasePerToken(
          previousTrade.baseAmount,
          previousTrade.tokenAmount,
        )
      : null;
    const tradesForLatest = previousTrade
      ? sortLaunchpadTrades([previousTrade, ...trades])
      : trades;
    const candles = buildLaunchpadCandles({
      trades,
      intervalSeconds: range.intervalSeconds,
      from: range.from,
      to: range.to,
      limit: request.limit,
      fill: request.fill,
      previousClose: previousClose ?? undefined,
    });
    const latest = getLatestTradePrice(tradesForLatest);

    const quote = getLaunchpadQuote(token, request.chainId);
    const markers = buildGraduationMarkers(token, range.from, range.to);
    const userTrades = traderAddress
      ? buildLaunchpadUserTradeMarkers(trades, traderAddress)
      : undefined;

    return {
      token,
      quote,
      range: {
        from: range.from,
        to: range.to,
        interval: request.interval,
        intervalSeconds: range.intervalSeconds,
        limit: request.limit,
      },
      source: token.graduated
        ? "bonding_curve_pre_graduation"
        : "bonding_curve",
      priceBasis: "execution_price",
      currency: request.currency,
      candles,
      latest,
      markers,
      ...(userTrades ? { userTrades } : {}),
    };
  }

  private async fetchLaunchpadToken(
    chainId: number,
    address: string,
  ): Promise<LaunchpadTokenRecord | null> {
    const ponderClient = getPonderClient(this.logger);
    const result = await ponderClient.query<{
      launchpadTokens?: { items?: LaunchpadTokenRecord[] };
    }>(
      `
        query GetLaunchpadTokenForCandles($where: launchpadTokenFilter = {}) {
          launchpadTokens(where: $where, limit: 1) {
            items {
              address
              chainId
              name
              symbol
              baseAsset
              graduated
              canGraduate
              v2Pair
              graduatedAt
              totalBuys
              totalSells
              totalVolumeBase
              lastTradeAt
              progress
            }
          }
        }
      `,
      { where: { chainId, address } },
    );

    return result.launchpadTokens?.items?.[0] ?? null;
  }

  private async fetchLatestLaunchpadTradeBefore(
    chainId: number,
    tokenAddress: string,
    timestamp: number,
  ): Promise<LaunchpadTradeRecord | null> {
    const ponderClient = getPonderClient(this.logger);
    const result = await ponderClient.query<{
      launchpadTrades?: {
        items?: Array<Pick<LaunchpadTradeRecord, "timestamp">>;
      };
    }>(
      `
        query GetLaunchpadTradeTimestampBeforeCandles($where: launchpadTradeFilter = {}) {
          launchpadTrades(where: $where, orderBy: "timestamp", orderDirection: "desc", limit: 1) {
            items {
              timestamp
            }
          }
        }
      `,
      {
        where: {
          chainId,
          tokenAddress,
          timestamp_lt: timestamp.toString(),
        },
      },
    );

    const latestTimestamp = result.launchpadTrades?.items?.[0]?.timestamp;
    if (!latestTimestamp) return null;

    const tiedTrades = await fetchLaunchpadTradePages({
      ponderClient,
      where: {
        chainId,
        tokenAddress,
        timestamp: latestTimestamp,
      },
      orderBy: "id",
      orderDirection: "asc",
    });
    const sorted = sortLaunchpadTrades(dedupeLaunchpadTradesById(tiedTrades));

    return sorted[sorted.length - 1] ?? null;
  }
}

export async function fetchLaunchpadTradesForCandles({
  ponderClient,
  chainId,
  tokenAddress,
  from,
  to,
}: {
  ponderClient: Pick<PonderClient, "query">;
  chainId: number;
  tokenAddress: string;
  from: number;
  to: number;
}): Promise<LaunchpadTradeRecord[]> {
  return fetchLaunchpadTradePages({
    ponderClient,
    where: {
      tokenAddress,
      chainId,
      timestamp_gte: from.toString(),
      timestamp_lte: to.toString(),
    },
    orderBy: "timestamp",
    orderDirection: "asc",
  });
}

async function fetchLaunchpadTradePages({
  ponderClient,
  where,
  orderBy,
  orderDirection,
}: {
  ponderClient: Pick<PonderClient, "query">;
  where: Record<string, unknown>;
  orderBy: "timestamp" | "id";
  orderDirection: "asc" | "desc";
}): Promise<LaunchpadTradeRecord[]> {
  const accumulated: LaunchpadTradeRecord[] = [];
  let after: string | undefined;

  for (let page = 0; page < MAX_LAUNCHPAD_TRADE_PAGES; page++) {
    const variables: { where: Record<string, unknown>; after?: string } = {
      where,
    };
    if (after) variables.after = after;

    const result = await ponderClient.query<LaunchpadTradesPageResult>(
      `
        query GetLaunchpadTradePage($where: launchpadTradeFilter = {}, $after: String) {
          launchpadTrades(
            where: $where,
            orderBy: "${orderBy}",
            orderDirection: "${orderDirection}",
            after: $after,
            limit: ${LAUNCHPAD_TRADE_PAGE_LIMIT}
          ) {
            items {
              id
              tokenAddress
              chainId
              trader
              isBuy
              baseAmount
              tokenAmount
              timestamp
              blockNumber
              txHash
            }
            pageInfo {
              endCursor
              hasNextPage
            }
          }
        }
      `,
      variables,
    );

    const pageItems = result.launchpadTrades?.items ?? [];
    accumulated.push(...pageItems);

    const pageInfo = result.launchpadTrades?.pageInfo;
    if (!pageInfo?.hasNextPage) {
      return accumulated;
    }

    if (!pageInfo.endCursor || pageInfo.endCursor === after) {
      throw new Error("Launchpad trade pagination cursor did not advance");
    }

    after = pageInfo.endCursor;
  }

  throw new Error("Launchpad trade pagination exceeded safety page limit");
}

export function resolveLaunchpadChartRange(
  request: Pick<LaunchpadCandlesRequest, "interval" | "limit" | "from" | "to">,
): ResolvedRange {
  const intervalSeconds = LAUNCHPAD_INTERVAL_SECONDS[request.interval];
  const now = Math.floor(Date.now() / 1000);
  const to = request.to ?? now;
  const lastAllowedBucket = bucketStart(to, intervalSeconds);
  const earliestAllowedBucket =
    lastAllowedBucket - intervalSeconds * (request.limit - 1);
  const requestedFrom = request.from ?? earliestAllowedBucket;
  const requestedFromBucket = bucketStart(requestedFrom, intervalSeconds);
  const from = Math.max(requestedFromBucket, earliestAllowedBucket);

  return { from, to, intervalSeconds };
}

export function buildLaunchpadCandles({
  trades,
  intervalSeconds,
  from,
  to,
  limit,
  fill,
  previousClose,
}: {
  trades: LaunchpadTradeRecord[];
  intervalSeconds: number;
  from: number;
  to: number;
  limit: number;
  fill: LaunchpadChartFill;
  previousClose?: number;
}): LaunchpadCandle[] {
  const buckets = new Map<number, CandleAccumulator>();
  const alignedFrom = bucketStart(from, intervalSeconds);

  for (const trade of sortLaunchpadTrades(dedupeLaunchpadTradesById(trades))) {
    const timestamp = parseInteger(trade.timestamp);
    if (timestamp === null || timestamp < alignedFrom || timestamp > to) {
      continue;
    }

    const price = executionPriceBasePerToken(
      trade.baseAmount,
      trade.tokenAmount,
    );
    if (price === null) continue;

    const bucketTime = bucketStart(timestamp, intervalSeconds);
    const baseAmount = toDecimal(trade.baseAmount, 18);
    const tokenAmount = toDecimal(trade.tokenAmount, 18);
    const existing = buckets.get(bucketTime);

    if (!existing) {
      buckets.set(bucketTime, {
        time: bucketTime,
        open: price,
        high: price,
        low: price,
        close: price,
        volumeBase: baseAmount,
        volumeToken: tokenAmount,
        tradeCount: 1,
        lastTradeTimestamp: timestamp,
      });
      continue;
    }

    existing.high = Math.max(existing.high, price);
    existing.low = Math.min(existing.low, price);
    existing.volumeBase += baseAmount;
    existing.volumeToken += tokenAmount;
    existing.tradeCount += 1;

    if (timestamp >= existing.lastTradeTimestamp) {
      existing.close = price;
      existing.lastTradeTimestamp = timestamp;
    }
  }

  const candles = Array.from(buckets.values())
    .sort((a, b) => a.time - b.time)
    .map(stripAccumulatorFields);

  const capped = candles.length > limit ? candles.slice(-limit) : candles;
  return fill === "last"
    ? fillMissingLaunchpadCandles(
        capped,
        intervalSeconds,
        alignedFrom,
        to,
        limit,
        previousClose,
      )
    : capped;
}

export function buildLaunchpadUserTradeMarkers(
  trades: LaunchpadTradeRecord[],
  traderAddress: string,
): LaunchpadUserTradeMarker[] {
  const normalizedTrader = traderAddress.toLowerCase();
  return sortLaunchpadTrades(dedupeLaunchpadTradesById(trades))
    .filter((trade) => trade.trader.toLowerCase() === normalizedTrader)
    .flatMap((trade) => {
      const timestamp = parseInteger(trade.timestamp);
      const blockNumber = parseInteger(trade.blockNumber);
      const price = executionPriceBasePerToken(
        trade.baseAmount,
        trade.tokenAmount,
      );
      if (
        timestamp === null ||
        blockNumber === null ||
        price === null ||
        !Number.isFinite(price) ||
        price <= 0
      ) {
        return [];
      }

      const side: "buy" | "sell" = trade.isBuy ? "buy" : "sell";
      return [
        {
          time: timestamp,
          side,
          price,
          baseAmount: toDecimal(trade.baseAmount, 18),
          tokenAmount: toDecimal(trade.tokenAmount, 18),
          txHash: trade.txHash,
          blockNumber,
        },
      ];
    })
    .sort((a, b) => {
      const timeDiff = a.time - b.time;
      if (timeDiff !== 0) return timeDiff;

      const blockDiff = a.blockNumber - b.blockNumber;
      if (blockDiff !== 0) return blockDiff;

      return a.txHash.localeCompare(b.txHash);
    });
}

export function executionPriceBasePerToken(
  baseAmountRaw: string,
  tokenAmountRaw: string,
): number | null {
  let baseAmount: number;
  let tokenAmount: number;

  try {
    baseAmount = toDecimal(baseAmountRaw, 18);
    tokenAmount = toDecimal(tokenAmountRaw, 18);
  } catch {
    return null;
  }

  if (!Number.isFinite(baseAmount) || baseAmount <= 0) return null;
  if (!Number.isFinite(tokenAmount) || tokenAmount <= 0) return null;
  return baseAmount / tokenAmount;
}

export function toDecimal(raw: string, decimals: number): number {
  return parseFloat(ethers.utils.formatUnits(raw, decimals));
}

export function bucketStart(
  timestamp: number,
  intervalSeconds: number,
): number {
  return Math.floor(timestamp / intervalSeconds) * intervalSeconds;
}

function fillMissingLaunchpadCandles(
  candles: LaunchpadCandle[],
  intervalSeconds: number,
  from: number,
  to: number,
  limit: number,
  previousClose?: number,
): LaunchpadCandle[] {
  const lastAllowedBucket = bucketStart(to, intervalSeconds);
  const earliestAllowedBucket = Math.max(
    bucketStart(from, intervalSeconds),
    lastAllowedBucket - intervalSeconds * (limit - 1),
  );
  if (candles.length === 0 && previousClose === undefined) return [];

  const byTime = new Map(candles.map((candle) => [candle.time, candle]));
  const firstBucket = candles[0]?.time;
  const start =
    previousClose === undefined && firstBucket !== undefined
      ? Math.max(firstBucket, earliestAllowedBucket)
      : earliestAllowedBucket;
  const result: LaunchpadCandle[] = [];
  let close = previousClose ?? candles[0].open;

  for (const candle of candles) {
    if (candle.time >= start) break;
    close = candle.close;
  }

  for (
    let bucket = start;
    bucket <= lastAllowedBucket && result.length < limit;
    bucket += intervalSeconds
  ) {
    const existing = byTime.get(bucket);
    if (existing) {
      result.push(existing);
      close = existing.close;
      continue;
    }

    result.push({
      time: bucket,
      open: close,
      high: close,
      low: close,
      close,
      volumeBase: 0,
      volumeToken: 0,
      tradeCount: 0,
    });
  }

  return result;
}

function sortLaunchpadTrades(
  trades: LaunchpadTradeRecord[],
): LaunchpadTradeRecord[] {
  return [...trades].sort((a, b) => {
    const timestampDiff = compareNullableNumbers(
      parseInteger(a.timestamp),
      parseInteger(b.timestamp),
    );
    if (timestampDiff !== 0) return timestampDiff;

    const blockDiff = compareNullableNumbers(
      parseInteger(a.blockNumber),
      parseInteger(b.blockNumber),
    );
    if (blockDiff !== 0) return blockDiff;

    return a.id.localeCompare(b.id);
  });
}

function dedupeLaunchpadTradesById(
  trades: LaunchpadTradeRecord[],
): LaunchpadTradeRecord[] {
  const seen = new Set<string>();
  const deduped: LaunchpadTradeRecord[] = [];

  for (const trade of trades) {
    if (seen.has(trade.id)) continue;
    seen.add(trade.id);
    deduped.push(trade);
  }

  return deduped;
}

function stripAccumulatorFields(candle: CandleAccumulator): LaunchpadCandle {
  return {
    time: candle.time,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volumeBase: candle.volumeBase,
    volumeToken: candle.volumeToken,
    tradeCount: candle.tradeCount,
  };
}

function getLatestTradePrice(
  trades: LaunchpadTradeRecord[],
): { price: number; timestamp: number } | null {
  for (let i = trades.length - 1; i >= 0; i--) {
    const trade = trades[i];
    const timestamp = parseInteger(trade.timestamp);
    if (timestamp === null) continue;

    const price = executionPriceBasePerToken(
      trade.baseAmount,
      trade.tokenAmount,
    );
    if (price !== null) {
      return { price, timestamp };
    }
  }
  return null;
}

function buildGraduationMarkers(
  token: LaunchpadTokenRecord,
  from: number,
  to: number,
): Array<{ time: number; type: "graduation"; pair: string | null }> {
  if (!token.graduatedAt) return [];

  const time = parseInteger(token.graduatedAt);
  if (time === null || time < from || time > to) {
    return [];
  }

  return [{ time, type: "graduation", pair: token.v2Pair }];
}

function parseInteger(value: string): number | null {
  if (!/^-?\d+$/.test(value)) return null;

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function compareNullableNumbers(a: number | null, b: number | null): number {
  if (a !== null && b !== null) return a - b;
  if (a === null && b !== null) return 1;
  if (a !== null && b === null) return -1;
  return 0;
}

function getLaunchpadQuote(
  token: LaunchpadTokenRecord,
  chainId: number,
): { address: string; symbol: string; decimals: number } {
  const contracts = getChainContracts(chainId);
  const baseAsset = token.baseAsset;
  const isJusd =
    contracts?.JUSD &&
    contracts.JUSD.toLowerCase() === token.baseAsset.toLowerCase();

  return {
    address: baseAsset,
    symbol: isJusd ? "JUSD" : "BASE",
    decimals: 18,
  };
}
