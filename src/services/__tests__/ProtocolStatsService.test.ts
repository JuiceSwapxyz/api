import { ChainId } from "@juiceswapxyz/sdk-core";
import Logger from "bunyan";
import axios from "axios";
import { ethers } from "ethers";
import { ProtocolStatsService } from "../ProtocolStatsService";
import type { ExploreStatsService } from "../ExploreStatsService";

jest.mock("axios");
jest.mock("../PriceService", () => ({
  PriceService: jest.fn().mockImplementation(() => ({
    getBtcPriceUsd: jest.fn().mockResolvedValue(100000),
  })),
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;

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

function createService() {
  const exploreStatsService = {
    getExploreStats: jest
      .fn()
      .mockResolvedValue({ stats: { poolStatsV2: [], poolStatsV3: [] } }),
  } as unknown as ExploreStatsService;

  // Empty provider map → getBridgeTvl short-circuits to 0 without a multicall,
  // so every axios.post seen here belongs to a bridge volume leg.
  return new ProtocolStatsService(
    new Map<ChainId, ethers.providers.StaticJsonRpcProvider>(),
    createMockLogger(),
    exploreStatsService,
  );
}

describe("ProtocolStatsService bridge volume", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedAxios.post.mockResolvedValue({
      data: {
        data: {
          volumeStats: {
            items: [
              {
                tokenAddress: "0x0000000000000000000000000000000000000001",
                timestamp: "1700000000",
                volume: ethers.utils.parseUnits("7", 18).toString(),
                type: "1h",
              },
            ],
          },
        },
      },
    });
  });

  it("queries only the LDS Ponder, never the JuiceDollar Ponder", async () => {
    const service = createService();

    await service.getProtocolStats(ChainId.CITREA_MAINNET);

    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    const [url, body] = mockedAxios.post.mock.calls[0];
    expect(url).toContain("lightning.space");
    expect(JSON.stringify({ url, body })).not.toMatch(
      /juicedollar|bridgeVolumeStats/i,
    );
  });

  it("reports bridge volume as the LDS leg alone", async () => {
    const service = createService();

    const stats = await service.getProtocolStats(ChainId.CITREA_MAINNET);

    expect(stats.historicalProtocolVolume.Month.bridge[0].value).toBe(7);
  });
});
