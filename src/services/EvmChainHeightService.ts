import { providers } from "ethers";
import { ChainId } from "@juiceswapxyz/sdk-core";
import Logger from "bunyan";

export class EvmChainHeightService {
  private logger: Logger;
  private providers: Map<ChainId, providers.StaticJsonRpcProvider>;

  constructor(
    logger: Logger,
    providerMap: Map<ChainId, providers.StaticJsonRpcProvider>,
  ) {
    this.logger = logger.child({ service: "EvmChainHeightService" });
    this.providers = providerMap;
  }

  getBlockHeight = async (chainId: ChainId): Promise<number> => {
    const provider = this.providers.get(chainId);
    if (!provider) {
      this.logger.error({ chainId }, "No provider configured for EVM chain");
      throw new Error(`No provider configured for EVM chain ${chainId}`);
    }

    return provider.getBlockNumber();
  };
}
