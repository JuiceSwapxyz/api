import Logger from "bunyan";
import { BitcoinTransaction } from "../types/MempoolSpace";

const BASE_URL = "https://blockstream.info/api";

export class BtcOnchainIndexerService {
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger.child({ service: "BtcOnchainIndexerService" });
  }

  getTransactionsByAddress = async (
    address: string,
  ): Promise<BitcoinTransaction[]> => {
    const res = await fetch(`${BASE_URL}/address/${address}/txs`);

    if (!res.ok) {
      this.logger.error({ res }, "Failed to get transactions by address");
      throw new Error(
        `Failed to get transactions by address: ${res.statusText}`,
      );
    }

    return await res.json();
  };

  fetchBlockTipHeight = async (): Promise<number> => {
    return await fetch(`${BASE_URL}/blocks/tip/height`)
      .then((response) => response.text())
      .then((height) => parseInt(height, 10));
  };
}
