import Logger from "bunyan";
import {
  buildLaunchpadCandles,
  buildLaunchpadUserTradeMarkers,
  bucketStart,
  executionPriceBasePerToken,
  fetchLaunchpadTradesForCandles,
  LaunchpadChartService,
  LaunchpadTradeRecord,
  resolveLaunchpadChartRange,
} from "../LaunchpadChartService";
import { getPonderClient } from "../PonderClient";
import {
  LaunchpadCandlesQuerySchema,
  LaunchpadTokenAddressParamsSchema,
} from "../../validation/schemas";

jest.mock("../PonderClient", () => ({
  getPonderClient: jest.fn(),
}));

function trade(overrides: Partial<LaunchpadTradeRecord>): LaunchpadTradeRecord {
  return {
    id: "tx-1-0",
    tokenAddress: "0xtoken",
    chainId: 4114,
    trader: "0x1111111111111111111111111111111111111111",
    isBuy: true,
    baseAmount: "1000000000000000000",
    tokenAmount: "1000000000000000000000",
    timestamp: "300",
    blockNumber: "10",
    txHash: "0xhash",
    ...overrides,
  };
}

function createMockLogger(): Logger {
  const logger = {
    child: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  logger.child.mockReturnValue(logger);
  return logger as unknown as Logger;
}

describe("LaunchpadChartService candle helpers", () => {
  it("computes execution price in base per token", () => {
    expect(
      executionPriceBasePerToken(
        "1000000000000000000",
        "250000000000000000000000",
      ),
    ).toBe(0.000004);
  });

  it("builds OHLCV candles per token from launchpad trades", () => {
    const trades = [
      trade({
        id: "a",
        baseAmount: "1000000000000000000",
        tokenAmount: "1000000000000000000000",
        timestamp: "300",
      }),
      trade({
        id: "b",
        baseAmount: "3000000000000000000",
        tokenAmount: "1000000000000000000000",
        timestamp: "320",
      }),
      trade({
        id: "c",
        isBuy: false,
        baseAmount: "2000000000000000000",
        tokenAmount: "1000000000000000000000",
        timestamp: "610",
      }),
    ];

    const candles = buildLaunchpadCandles({
      trades,
      intervalSeconds: 300,
      from: 0,
      to: 900,
      limit: 100,
      fill: "none",
    });

    expect(candles).toEqual([
      {
        time: 300,
        open: 0.001,
        high: 0.003,
        low: 0.001,
        close: 0.003,
        volumeBase: 4,
        volumeToken: 2000,
        tradeCount: 2,
      },
      {
        time: 600,
        open: 0.002,
        high: 0.002,
        low: 0.002,
        close: 0.002,
        volumeBase: 2,
        volumeToken: 1000,
        tradeCount: 1,
      },
    ]);
  });

  it("sorts trades before computing candle open and close", () => {
    const candles = buildLaunchpadCandles({
      trades: [
        trade({
          id: "b",
          baseAmount: "3000000000000000000",
          tokenAmount: "1000000000000000000000",
          timestamp: "320",
          blockNumber: "11",
        }),
        trade({
          id: "a",
          baseAmount: "1000000000000000000",
          tokenAmount: "1000000000000000000000",
          timestamp: "300",
          blockNumber: "10",
        }),
      ],
      intervalSeconds: 300,
      from: 0,
      to: 600,
      limit: 100,
      fill: "none",
    });

    expect(candles[0]).toMatchObject({
      time: 300,
      open: 0.001,
      close: 0.003,
    });
  });

  it("aligns resolved ranges to bucket starts and caps to the requested limit", () => {
    expect(
      resolveLaunchpadChartRange({
        interval: "5m",
        limit: 3,
        from: 650,
        to: 1199,
      }),
    ).toEqual({ from: 600, to: 1199, intervalSeconds: 300 });

    expect(
      resolveLaunchpadChartRange({
        interval: "5m",
        limit: 3,
        from: 0,
        to: 1199,
      }),
    ).toEqual({ from: 300, to: 1199, intervalSeconds: 300 });
  });

  it("includes the full first bucket when from falls inside the bucket", () => {
    const candles = buildLaunchpadCandles({
      trades: [
        trade({
          id: "a",
          baseAmount: "1000000000000000000",
          tokenAmount: "1000000000000000000000",
          timestamp: "620",
        }),
        trade({
          id: "b",
          baseAmount: "2000000000000000000",
          tokenAmount: "1000000000000000000000",
          timestamp: "700",
        }),
      ],
      intervalSeconds: 300,
      from: 650,
      to: 900,
      limit: 10,
      fill: "none",
    });

    expect(candles).toEqual([
      {
        time: 600,
        open: 0.001,
        high: 0.002,
        low: 0.001,
        close: 0.002,
        volumeBase: 3,
        volumeToken: 2000,
        tradeCount: 2,
      },
    ]);
  });

  it("deduplicates trades by id before counting candle volume", () => {
    const duplicate = trade({
      id: "a",
      baseAmount: "1000000000000000000",
      tokenAmount: "1000000000000000000000",
      timestamp: "300",
    });

    const candles = buildLaunchpadCandles({
      trades: [duplicate, duplicate],
      intervalSeconds: 300,
      from: 0,
      to: 600,
      limit: 10,
      fill: "none",
    });

    expect(candles).toEqual([
      {
        time: 300,
        open: 0.001,
        high: 0.001,
        low: 0.001,
        close: 0.001,
        volumeBase: 1,
        volumeToken: 1000,
        tradeCount: 1,
      },
    ]);
  });

  it("fills missing buckets with last close without inventing volume", () => {
    const candles = buildLaunchpadCandles({
      trades: [
        trade({
          id: "a",
          baseAmount: "1000000000000000000",
          tokenAmount: "1000000000000000000000",
          timestamp: "300",
        }),
        trade({
          id: "b",
          baseAmount: "2000000000000000000",
          tokenAmount: "1000000000000000000000",
          timestamp: "900",
        }),
      ],
      intervalSeconds: 300,
      from: 0,
      to: 900,
      limit: 10,
      fill: "last",
    });

    expect(candles.map((candle) => candle.time)).toEqual([300, 600, 900]);
    expect(candles[1]).toMatchObject({
      open: 0.001,
      high: 0.001,
      low: 0.001,
      close: 0.001,
      volumeBase: 0,
      volumeToken: 0,
      tradeCount: 0,
    });
  });

  it("uses the last close before the visible range when filling sparse candles", () => {
    const candles = buildLaunchpadCandles({
      trades: [
        trade({
          id: "a",
          baseAmount: "1000000000000000000",
          tokenAmount: "1000000000000000000000",
          timestamp: "0",
        }),
        trade({
          id: "b",
          baseAmount: "2000000000000000000",
          tokenAmount: "1000000000000000000000",
          timestamp: "300",
        }),
        trade({
          id: "c",
          baseAmount: "3000000000000000000",
          tokenAmount: "1000000000000000000000",
          timestamp: "1200",
        }),
      ],
      intervalSeconds: 300,
      from: 0,
      to: 1200,
      limit: 3,
      fill: "last",
    });

    expect(candles).toEqual([
      {
        time: 600,
        open: 0.002,
        high: 0.002,
        low: 0.002,
        close: 0.002,
        volumeBase: 0,
        volumeToken: 0,
        tradeCount: 0,
      },
      {
        time: 900,
        open: 0.002,
        high: 0.002,
        low: 0.002,
        close: 0.002,
        volumeBase: 0,
        volumeToken: 0,
        tradeCount: 0,
      },
      {
        time: 1200,
        open: 0.003,
        high: 0.003,
        low: 0.003,
        close: 0.003,
        volumeBase: 3,
        volumeToken: 1000,
        tradeCount: 1,
      },
    ]);
  });

  it("fills an otherwise empty visible range from a previous close seed", () => {
    const candles = buildLaunchpadCandles({
      trades: [],
      intervalSeconds: 300,
      from: 600,
      to: 1200,
      limit: 3,
      fill: "last",
      previousClose: 0.002,
    });

    expect(candles).toEqual([
      {
        time: 600,
        open: 0.002,
        high: 0.002,
        low: 0.002,
        close: 0.002,
        volumeBase: 0,
        volumeToken: 0,
        tradeCount: 0,
      },
      {
        time: 900,
        open: 0.002,
        high: 0.002,
        low: 0.002,
        close: 0.002,
        volumeBase: 0,
        volumeToken: 0,
        tradeCount: 0,
      },
      {
        time: 1200,
        open: 0.002,
        high: 0.002,
        low: 0.002,
        close: 0.002,
        volumeBase: 0,
        volumeToken: 0,
        tradeCount: 0,
      },
    ]);
  });

  it("fills before the first visible trade from a previous close seed", () => {
    const candles = buildLaunchpadCandles({
      trades: [
        trade({
          id: "a",
          baseAmount: "3000000000000000000",
          tokenAmount: "1000000000000000000000",
          timestamp: "1200",
        }),
      ],
      intervalSeconds: 300,
      from: 600,
      to: 1200,
      limit: 3,
      fill: "last",
      previousClose: 0.002,
    });

    expect(candles).toEqual([
      {
        time: 600,
        open: 0.002,
        high: 0.002,
        low: 0.002,
        close: 0.002,
        volumeBase: 0,
        volumeToken: 0,
        tradeCount: 0,
      },
      {
        time: 900,
        open: 0.002,
        high: 0.002,
        low: 0.002,
        close: 0.002,
        volumeBase: 0,
        volumeToken: 0,
        tradeCount: 0,
      },
      {
        time: 1200,
        open: 0.003,
        high: 0.003,
        low: 0.003,
        close: 0.003,
        volumeBase: 3,
        volumeToken: 1000,
        tradeCount: 1,
      },
    ]);
  });

  it("builds per-token user buy/sell markers", () => {
    const markers = buildLaunchpadUserTradeMarkers(
      [
        trade({
          id: "a",
          trader: "0x2222222222222222222222222222222222222222",
          isBuy: true,
          timestamp: "300",
          txHash: "0xbuy",
        }),
        trade({
          id: "b",
          trader: "0x1111111111111111111111111111111111111111",
          isBuy: false,
          timestamp: "600",
          txHash: "0xsell",
          blockNumber: "42",
        }),
      ],
      "0x1111111111111111111111111111111111111111",
    );

    expect(markers).toEqual([
      {
        time: 600,
        side: "sell",
        price: 0.001,
        baseAmount: 1,
        tokenAmount: 1000,
        txHash: "0xsell",
        blockNumber: 42,
      },
    ]);
  });

  it("skips user trade markers with invalid timestamps, blocks, or amounts", () => {
    const markers = buildLaunchpadUserTradeMarkers(
      [
        trade({
          id: "valid",
          timestamp: "300",
          blockNumber: "10",
          txHash: "0xvalid",
        }),
        trade({
          id: "bad-timestamp",
          timestamp: "300abc",
          blockNumber: "11",
          txHash: "0xbadtime",
        }),
        trade({
          id: "bad-block",
          timestamp: "310",
          blockNumber: "11abc",
          txHash: "0xbadblock",
        }),
        trade({
          id: "zero-amount",
          timestamp: "320",
          blockNumber: "12",
          tokenAmount: "0",
          txHash: "0xzero",
        }),
      ],
      "0x1111111111111111111111111111111111111111",
    );

    expect(markers).toEqual([
      {
        time: 300,
        side: "buy",
        price: 0.001,
        baseAmount: 1,
        tokenAmount: 1000,
        txHash: "0xvalid",
        blockNumber: 10,
      },
    ]);
  });

  it("computes deterministic bucket starts", () => {
    expect(bucketStart(899, 300)).toBe(600);
    expect(bucketStart(900, 300)).toBe(900);
  });

  it("does not compute a price for zero-amount trades", () => {
    expect(
      executionPriceBasePerToken("0", "1000000000000000000000"),
    ).toBeNull();
    expect(executionPriceBasePerToken("1000000000000000000", "0")).toBeNull();
  });
});

describe("LaunchpadChartService Ponder pagination", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("uses Ponder cursors so same-timestamp pages beyond 1000 are not skipped", async () => {
    const firstPage = Array.from({ length: 1000 }, (_, index) =>
      trade({
        id: `same-${index.toString().padStart(4, "0")}`,
        timestamp: "123",
      }),
    );
    const overflowTrade = trade({ id: "same-1000", timestamp: "123" });
    const query = jest
      .fn()
      .mockResolvedValueOnce({
        launchpadTrades: {
          items: firstPage,
          pageInfo: { endCursor: "cursor-1", hasNextPage: true },
        },
      })
      .mockResolvedValueOnce({
        launchpadTrades: {
          items: [overflowTrade],
          pageInfo: { endCursor: "cursor-2", hasNextPage: false },
        },
      });
    const where = {
      tokenAddress: "0xtoken",
      chainId: 4114,
      timestamp_gte: "100",
      timestamp_lte: "200",
    };

    const trades = await fetchLaunchpadTradesForCandles({
      ponderClient: { query },
      chainId: 4114,
      tokenAddress: "0xtoken",
      from: 100,
      to: 200,
    });

    expect(trades).toHaveLength(1001);
    expect(trades[1000]).toBe(overflowTrade);
    expect(query).toHaveBeenNthCalledWith(1, expect.any(String), { where });
    expect(query).toHaveBeenNthCalledWith(2, expect.any(String), {
      where,
      after: "cursor-1",
    });
  });

  it("fetches all trades at the latest previous timestamp before selecting the seed", async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({
        launchpadTrades: {
          items: [{ timestamp: "90" }],
        },
      })
      .mockResolvedValueOnce({
        launchpadTrades: {
          items: [
            trade({
              id: "b",
              timestamp: "90",
              blockNumber: "12",
              baseAmount: "2000000000000000000",
            }),
            trade({
              id: "a",
              timestamp: "90",
              blockNumber: "10",
              baseAmount: "1000000000000000000",
            }),
            trade({
              id: "c",
              timestamp: "90",
              blockNumber: "12",
              baseAmount: "3000000000000000000",
            }),
          ],
          pageInfo: { endCursor: "cursor-1", hasNextPage: false },
        },
      });
    (getPonderClient as jest.Mock).mockReturnValue({ query });

    const service = new LaunchpadChartService(createMockLogger());
    const previousTrade = await (
      service as unknown as {
        fetchLatestLaunchpadTradeBefore: (
          chainId: number,
          tokenAddress: string,
          timestamp: number,
        ) => Promise<LaunchpadTradeRecord | null>;
      }
    ).fetchLatestLaunchpadTradeBefore(4114, "0xtoken", 100);

    expect(previousTrade?.id).toBe("c");
    expect(previousTrade?.baseAmount).toBe("3000000000000000000");
    expect(query).toHaveBeenNthCalledWith(1, expect.any(String), {
      where: {
        chainId: 4114,
        tokenAddress: "0xtoken",
        timestamp_lt: "100",
      },
    });
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('orderBy: "id"'),
      {
        where: {
          chainId: 4114,
          tokenAddress: "0xtoken",
          timestamp: "90",
        },
      },
    );
  });
});

describe("Launchpad candles validation", () => {
  it("accepts base currency and rejects usd currency", () => {
    expect(
      LaunchpadCandlesQuerySchema.parse({ currency: "base" }),
    ).toMatchObject({
      chainId: 4114,
      currency: "base",
    });

    expect(
      LaunchpadCandlesQuerySchema.safeParse({ currency: "usd" }).success,
    ).toBe(false);
  });

  it("accepts from zero while still rejecting to zero", () => {
    expect(
      LaunchpadCandlesQuerySchema.parse({ from: "0", to: "1" }),
    ).toMatchObject({
      from: 0,
      to: 1,
    });

    expect(LaunchpadCandlesQuerySchema.safeParse({ to: "0" }).success).toBe(
      false,
    );
    expect(
      LaunchpadCandlesQuerySchema.safeParse({ from: "-1", to: "1" }).success,
    ).toBe(false);
  });

  it("rejects invalid ranges, chains, and token addresses", () => {
    expect(
      LaunchpadCandlesQuerySchema.safeParse({ from: "20", to: "10" }).success,
    ).toBe(false);
    expect(
      LaunchpadCandlesQuerySchema.safeParse({ chainId: "1" }).success,
    ).toBe(false);
    expect(
      LaunchpadTokenAddressParamsSchema.safeParse({ address: "not-address" })
        .success,
    ).toBe(false);
  });
});
