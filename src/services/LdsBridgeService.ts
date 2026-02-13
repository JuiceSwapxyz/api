import Logger from "bunyan";

const LDS_BRIDGE_URL = "https://lightning.space/v1/swap";

export class LdsBridgeService {
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger.child({ service: "LdsBridgeService" });
  }

  async getCurrentStatus(
    swapIds: string[],
  ): Promise<Record<string, { status: string; failureReason?: string }>> {
    if (!swapIds.length) return {};

    const CHUNK_SIZE = 64;
    const chunks = Array.from(
      { length: Math.ceil(swapIds.length / CHUNK_SIZE) },
      (_, i) => swapIds.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
    );

    const results = await Promise.all(
      chunks.map((chunk) => this.fetchChunkStatus(chunk)),
    );
    return Object.assign({}, ...results);
  }

  private async fetchChunkStatus(
    ids: string[],
  ): Promise<Record<string, { status: string; failureReason?: string }>> {
    const url =
      ids.length === 1
        ? `${LDS_BRIDGE_URL}/v2/swap/${ids[0]}`
        : `${LDS_BRIDGE_URL}/v2/swap/status?${ids.map((id) => `ids=${id}`).join("&")}`;

    try {
      const res = await fetch(url);
      if (!res.ok) {
        this.logger.warn(
          { ids, status: res.status },
          "Failed to fetch swap status",
        );
        return {};
      }
      const data = await res.json();
      return ids.length === 1
        ? {
            [ids[0]]: {
              status: data.status,
              failureReason: data.failureReason,
            },
          }
        : data;
    } catch (err) {
      this.logger.error({ err, ids }, "Error fetching swap status from LDS");
      return {};
    }
  }
}
