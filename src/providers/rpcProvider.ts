import { providers } from 'ethers';
import { ChainId } from '@juiceswapxyz/sdk-core';
import Logger from 'bunyan';
import * as dotenv from 'dotenv';
import { initializeRPCMonitor } from '../utils/rpcMonitor';

dotenv.config();

export interface ChainConfig {
  chainId: ChainId;
  name: string;
  rpcUrl: string;
}

// Build Alchemy RPC URL from API key
function buildAlchemyUrl(chainId: ChainId): string {
  const alchemyKey = process.env[`ALCHEMY_${chainId}`];
  if (!alchemyKey) return '';

  // Citrea uses custom Azure RPC node
  if (alchemyKey === 'none' || chainId === ChainId.CITREA_TESTNET) {
    if (!process.env.CITREA_RPC_URL) {
      throw new Error('CITREA_RPC_URL environment variable is required for Citrea');
    }
    return process.env.CITREA_RPC_URL;
  }

  // Build Alchemy URL based on chain
  switch (chainId) {
    case ChainId.MAINNET:
      return `https://eth-mainnet.g.alchemy.com/v2/${alchemyKey}`;
    case ChainId.OPTIMISM:
      return `https://opt-mainnet.g.alchemy.com/v2/${alchemyKey}`;
    case ChainId.POLYGON:
      return `https://polygon-mainnet.g.alchemy.com/v2/${alchemyKey}`;
    case ChainId.BASE:
      return `https://base-mainnet.g.alchemy.com/v2/${alchemyKey}`;
    case ChainId.ARBITRUM_ONE:
      return `https://arb-mainnet.g.alchemy.com/v2/${alchemyKey}`;
    case ChainId.SEPOLIA:
      return `https://eth-sepolia.g.alchemy.com/v2/${alchemyKey}`;
    default:
      return '';
  }
}

// Supported chains configuration
const CHAIN_CONFIGS: ChainConfig[] = [
  {
    chainId: ChainId.MAINNET,
    name: 'Ethereum Mainnet',
    rpcUrl: buildAlchemyUrl(ChainId.MAINNET),
  },
  {
    chainId: ChainId.OPTIMISM,
    name: 'Optimism',
    rpcUrl: buildAlchemyUrl(ChainId.OPTIMISM),
  },
  {
    chainId: ChainId.POLYGON,
    name: 'Polygon',
    rpcUrl: buildAlchemyUrl(ChainId.POLYGON),
  },
  {
    chainId: ChainId.BASE,
    name: 'Base',
    rpcUrl: buildAlchemyUrl(ChainId.BASE),
  },
  {
    chainId: ChainId.ARBITRUM_ONE,
    name: 'Arbitrum',
    rpcUrl: buildAlchemyUrl(ChainId.ARBITRUM_ONE),
  },
  {
    chainId: ChainId.SEPOLIA,
    name: 'Sepolia Testnet',
    rpcUrl: buildAlchemyUrl(ChainId.SEPOLIA),
  },
  {
    chainId: ChainId.CITREA_TESTNET,
    name: 'Citrea Testnet',
    rpcUrl: buildAlchemyUrl(ChainId.CITREA_TESTNET),
  },
];

export function initializeProviders(logger: Logger): Map<ChainId, providers.StaticJsonRpcProvider> {
  const providerMap = new Map<ChainId, providers.StaticJsonRpcProvider>();

  // Initialize RPC monitor for tracking calls
  const rpcMonitor = initializeRPCMonitor(logger);

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

      // Attach RPC monitor to track calls
      rpcMonitor.attachToProvider(provider, config.chainId);

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