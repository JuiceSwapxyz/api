import { BridgeSwap } from "../../generated/prisma";
import { BtcOnchainIndexerService } from "../../services/BtcOnchainIndexerService";
import { EvmBridgeIndexer } from "../../services/EvmBrigdeIndexer";

export type SwapFixerFn = (swap: BridgeSwap) => Promise<BridgeSwap>;

export interface SwapFixerDeps {
  btcOnchainIndexerService: BtcOnchainIndexerService;
  evmBridgeIndexerService: EvmBridgeIndexer;
}
