import { Request, Response } from "express";
import { createQuoteHandler } from "../../endpoints/quote";
import { createSwapsHandler } from "../../endpoints/swaps";
import Logger from "bunyan";
import { ExploreStatsService } from "../../services/ExploreStatsService";

let quoteHandler: any;
let swapsHandler: any;
let exploreStatsService: ExploreStatsService | null = null;

const CHAIN_NAME_TO_CHAIN_ID: Record<string, number> = {
  ETHEREUM: 1,
  ETHEREUM_SEPOLIA: 11155111,
  POLYGON: 137,
  CITREA_MAINNET: 4114,
  CITREA_TESTNET: 5115,
};

export function initializeResolvers(
  routerService: any,
  logger: Logger,
  exploreStats?: ExploreStatsService,
) {
  quoteHandler = createQuoteHandler(routerService, logger);
  swapsHandler = createSwapsHandler(routerService, logger);
  exploreStatsService = exploreStats ?? null;
}

// Helper to convert Express handlers to GraphQL resolvers
const createMockResponse = (): {
  res: Response;
  getResponse: () => Promise<any>;
} => {
  let responseData: any = null;
  let statusCode = 200;
  let resolver: (value: any) => void;
  const responsePromise = new Promise((resolve) => {
    resolver = resolve;
  });

  const res = {
    status: (code: number) => {
      statusCode = code;
      return res;
    },
    json: (data: any) => {
      responseData = data;
      resolver(data);
      return res;
    },
    send: (data: any) => {
      if (typeof data === "string") {
        try {
          responseData = JSON.parse(data);
        } catch {
          responseData = data;
        }
      } else {
        responseData = data;
      }
      resolver(responseData);
      return res;
    },
    setHeader: () => res,
  } as unknown as Response;

  const getResponse = async () => {
    await responsePromise;

    if (statusCode >= 400) {
      throw new Error(
        responseData?.message || responseData?.detail || "Request failed",
      );
    }

    return responseData;
  };

  return { res, getResponse };
};

function mapTxToPoolTransaction(
  tx: {
    hash: string;
    chain: string;
    timestamp: number;
    account: string;
    usdValue?: { value?: number };
    token0?: { chain?: string; address?: string; symbol?: string; decimals?: number; project?: { name?: string } };
    token0Quantity: string;
    token1?: { chain?: string; address?: string; symbol?: string; decimals?: number; project?: { name?: string } };
    token1Quantity: string;
    type: string;
    protocolVersion: string;
  },
  chainId: number,
) {
  const chainEnum = tx.chain?.toUpperCase() ?? "CITREA_MAINNET";
  const mapToken = (t: typeof tx.token0, side: string) => {
    if (!t) {
      return {
        id: `empty-${tx.hash}-${side}`,
        chainId,
        chain: chainEnum,
        address: "",
        symbol: "",
        decimals: 0,
        project: { id: "empty", name: null, tokens: [], logo: null },
      };
    }
    return {
      id: `${chainId}-${t.address ?? ""}`,
      chainId,
      chain: chainEnum,
      address: t.address ?? "",
      symbol: t.symbol ?? "",
      decimals: t.decimals ?? 0,
      project: {
        id: t.address ?? "",
        name: t.project?.name ?? t.symbol ?? null,
        tokens: [],
        logo: null,
      },
    };
  };
  return {
    id: `${tx.hash}-${tx.timestamp}`,
    chain: chainEnum,
    protocolVersion: (tx.protocolVersion?.toUpperCase() ?? "V4") as "V2" | "V3" | "V4",
    type: (tx.type?.toUpperCase() ?? "SWAP") as "SWAP" | "ADD" | "REMOVE",
    hash: tx.hash,
    timestamp: tx.timestamp,
    usdValue: {
      id: `${tx.hash}-usd`,
      value: tx.usdValue?.value ?? 0,
      currency: "USD",
    },
    account: tx.account,
    token0: mapToken(tx.token0, "0"),
    token0Quantity: tx.token0Quantity,
    token1: mapToken(tx.token1, "1"),
    token1Quantity: tx.token1Quantity,
  };
}

async function getPoolTransactions(
  _: any,
  { chain, first, timestampCursor }: { chain: string; first: number; timestampCursor?: number },
) {
  const chainId = CHAIN_NAME_TO_CHAIN_ID[chain];
  if (chainId == null || !exploreStatsService) return [];
  const data = await exploreStatsService.getExploreStats(chainId);
  const list = (data?.stats?.transactionStats ?? [])
    .slice()
    .sort((a, b) => b.timestamp - a.timestamp);
  const filtered =
    timestampCursor != null ? list.filter((t) => t.timestamp < timestampCursor) : list;
  return filtered.slice(0, first).map((t) => mapTxToPoolTransaction(t, chainId));
}

export const resolvers = {
  Query: {
    health: () => "ok",

    v2Transactions: getPoolTransactions,
    v3Transactions: getPoolTransactions,
    v4Transactions: getPoolTransactions,

    swaps: async (
      _: any,
      { txHashes, chainId }: { txHashes: string[]; chainId: number },
    ) => {
      const { res, getResponse } = createMockResponse();

      const req = {
        query: {
          txHashes: txHashes.join(","),
          chainId: chainId.toString(),
        },
      } as unknown as Request;

      await swapsHandler(req, res);

      return await getResponse();
    },

    quote: async (_: any, { input }: { input: any }) => {
      const { res, getResponse } = createMockResponse();

      const req = {
        body: {
          tokenInAddress: input.tokenInAddress,
          tokenInChainId: input.tokenInChainId,
          tokenOutAddress: input.tokenOutAddress,
          tokenOutChainId: input.tokenOutChainId,
          amount: input.amount,
          type: input.type,
          swapper: input.swapper,
          slippageTolerance: input.slippageTolerance,
          deadline: input.deadline,
        },
        headers: {},
      } as unknown as Request;

      await quoteHandler(req, res);

      return await getResponse();
    },
  },
};
