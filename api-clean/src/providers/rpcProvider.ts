import { providers } from 'ethers';
import { ChainId } from '@juiceswapxyz/sdk-core';
import Logger from 'bunyan';
import * as dotenv from 'dotenv';

dotenv.config();

export interface ChainConfig {
  chainId: ChainId;
  name: string;
  rpcUrl: string;
}

// Supported chains configuration
const CHAIN_CONFIGS: ChainConfig[] = [
  {
    chainId: ChainId.MAINNET,
    name: 'Ethereum Mainnet',
    rpcUrl: process.env.RPC_1 || '',
  },
  {
    chainId: ChainId.OPTIMISM,
    name: 'Optimism',
    rpcUrl: process.env.RPC_10 || '',
  },
  {
    chainId: ChainId.POLYGON,
    name: 'Polygon',
    rpcUrl: process.env.RPC_137 || '',
  },
  {
    chainId: ChainId.BASE,
    name: 'Base',
    rpcUrl: process.env.RPC_8453 || '',
  },
  {
    chainId: ChainId.ARBITRUM_ONE,
    name: 'Arbitrum',
    rpcUrl: process.env.RPC_42161 || '',
  },
  {
    chainId: ChainId.SEPOLIA,
    name: 'Sepolia Testnet',
    rpcUrl: process.env.RPC_11155111 || '',
  },
  {
    chainId: ChainId.CITREA_TESTNET,
    name: 'Citrea Testnet',
    rpcUrl: process.env.RPC_5115 || 'https://rpc.citrea.xyz',
  },
];

export function initializeProviders(logger: Logger): Map<ChainId, providers.StaticJsonRpcProvider> {
  const providerMap = new Map<ChainId, providers.StaticJsonRpcProvider>();

  for (const config of CHAIN_CONFIGS) {
    if (!config.rpcUrl) {
      logger.warn(`No RPC URL configured for ${config.name} (Chain ID: ${config.chainId})`);
      continue;
    }

    try {
      const provider = new providers.StaticJsonRpcProvider(
        {
          url: config.rpcUrl,
          timeout: 10000,
        },
        config.chainId
      );

      // Set polling interval for better performance
      provider.pollingInterval = 12000;

      providerMap.set(config.chainId, provider);
      logger.info(`Initialized provider for ${config.name} (Chain ID: ${config.chainId})`);
    } catch (error) {
      logger.error(
        { error, chain: config.name },
        `Failed to initialize provider for ${config.name}`
      );
    }
  }

  if (providerMap.size === 0) {
    throw new Error('No RPC providers could be initialized');
  }

  logger.info(`Successfully initialized ${providerMap.size} RPC providers`);
  return providerMap;
}

export function getChainName(chainId: ChainId): string {
  const config = CHAIN_CONFIGS.find(c => c.chainId === chainId);
  return config?.name || `Chain ${chainId}`;
}

// Helper function to verify provider connectivity
export async function verifyProviders(
  providers: Map<ChainId, providers.StaticJsonRpcProvider>,
  logger: Logger
): Promise<void> {
  const verificationPromises = Array.from(providers.entries()).map(
    async ([chainId, provider]) => {
      try {
        const blockNumber = await provider.getBlockNumber();
        logger.info(
          `Provider for ${getChainName(chainId)} is healthy (block: ${blockNumber})`
        );
      } catch (error) {
        logger.error(
          { error, chainId },
          `Provider for ${getChainName(chainId)} is not responding`
        );
      }
    }
  );

  await Promise.allSettled(verificationPromises);
}