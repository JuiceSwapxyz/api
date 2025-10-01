import {
  AlphaRouter,
  AlphaRouterConfig,
  SwapOptions,
  SwapRoute,
  SwapType,
  V3PoolProvider,
  TokenProvider,
  UniswapMulticallProvider,
  CachingTokenProviderWithFallback,
  NodeJSCache,
  EIP1559GasPriceProvider,
  nativeOnChain,
} from '@juiceswapxyz/smart-order-router';
import NodeCache from 'node-cache';
import {
  ChainId,
  CurrencyAmount,
  TradeType,
  Currency,
  Token,
  Percent,
} from '@juiceswapxyz/sdk-core';
import { Protocol } from '@juiceswapxyz/router-sdk';
import { providers } from 'ethers';
import Logger from 'bunyan';
import JSBI from 'jsbi';
import { CitreaStaticV3SubgraphProvider } from '../providers/CitreaStaticV3SubgraphProvider';
import { createLocalTokenListProvider } from '../lib/handlers/router-entities/local-token-list-provider';

export interface QuoteParams {
  tokenIn: string;
  tokenOut: string;
  tokenInDecimals: number;
  tokenOutDecimals: number;
  amount: string;
  chainId: ChainId;
  type: 'exactIn' | 'exactOut';
  recipient?: string;
  slippageTolerance?: number;
  protocols?: Protocol[];
  enableUniversalRouter?: boolean;
}

export interface SwapParams extends QuoteParams {
  recipient: string;
  slippageTolerance: number;
  deadline?: number;
  from: string;
}

export class RouterService {
  private routers: Map<ChainId, AlphaRouter>;
  private providers: Map<ChainId, providers.StaticJsonRpcProvider>;
  private tokenProviders: Map<ChainId, any>;
  private v3PoolProviders: Map<ChainId, V3PoolProvider>;
  private logger: Logger;

  private constructor(
    rpcProviders: Map<ChainId, providers.StaticJsonRpcProvider>,
    logger: Logger
  ) {
    this.providers = rpcProviders;
    this.logger = logger;
    this.routers = new Map();
    this.tokenProviders = new Map();
    this.v3PoolProviders = new Map();
  }

  static async create(
    rpcProviders: Map<ChainId, providers.StaticJsonRpcProvider>,
    logger: Logger
  ): Promise<RouterService> {
    const instance = new RouterService(rpcProviders, logger);
    await instance.initialize();
    return instance;
  }

  private async initialize(): Promise<void> {
    // Initialize routers for each chain with essential providers
    for (const [chainId, provider] of this.providers.entries()) {
      // Initialize multicall provider for efficient batching
      const multicallProvider = new UniswapMulticallProvider(
        chainId,
        provider,
        375000
      );

      // Initialize token provider with Ponder integration for Citrea
      let tokenProvider;
      if (chainId === ChainId.CITREA_TESTNET) {
        tokenProvider = await createLocalTokenListProvider(chainId);
      } else {
        // Initialize basic token provider for non-Citrea chains
        const baseTokenProvider = new TokenProvider(chainId, multicallProvider);

        // Use caching wrapper with fallback
        const tokenCache = new NodeJSCache<Token>(
          new NodeCache({ stdTTL: 3600, checkperiod: 600 })
        );
        tokenProvider = new CachingTokenProviderWithFallback(
          chainId,
          tokenCache,
          baseTokenProvider,
          baseTokenProvider
        );
      }

      // Store token provider for token lookup
      this.tokenProviders.set(chainId, tokenProvider);

      // Initialize V3 pool provider only - no V2 needed
      const v3PoolProvider = new V3PoolProvider(chainId, multicallProvider);

      // Store v3PoolProvider for pool address computation
      this.v3PoolProviders.set(chainId, v3PoolProvider);

      // Gas price provider
      const gasPriceProvider = new EIP1559GasPriceProvider(provider);

      // For Citrea: use custom subgraph provider with static pools
      let v3SubgraphProvider = undefined;
      if (chainId === ChainId.CITREA_TESTNET) {
        v3SubgraphProvider = new CitreaStaticV3SubgraphProvider(chainId, v3PoolProvider);
      }

      // Initialize router with essential providers
      this.routers.set(chainId, new AlphaRouter({
        chainId,
        provider,
        multicall2Provider: multicallProvider,
        tokenProvider,
        v3PoolProvider,
        gasPriceProvider,
        ...(v3SubgraphProvider && { v3SubgraphProvider }),
      }));
    }
  }

  /**
   * Get token information (decimals, symbol, name) from token lists or on-chain
   * Matches develop branch CurrencyLookup behavior
   */
  async getTokenInfo(address: string, chainId: ChainId): Promise<{
    decimals: number;
    symbol?: string;
    name?: string;
  }> {
    // Check if native currency
    const NATIVE_ADDRESSES = [
      '0x0000000000000000000000000000000000000000',
      '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'
    ];

    if (NATIVE_ADDRESSES.some(addr => addr.toLowerCase() === address.toLowerCase())) {
      const nativeToken = nativeOnChain(chainId);
      return {
        decimals: nativeToken.decimals,
        symbol: nativeToken.symbol,
        name: nativeToken.name,
      };
    }

    // Get token from token provider
    const tokenProvider = this.tokenProviders.get(chainId);
    if (!tokenProvider) {
      throw new Error(`No token provider available for chain ${chainId}`);
    }

    try {
      // Token list providers have getTokenByAddress method
      const token = await tokenProvider.getTokenByAddress(address);
      if (token) {
        this.logger.debug({ address, chainId, decimals: token.decimals }, 'Found token in token list');
        return {
          decimals: token.decimals,
          symbol: token.symbol,
          name: token.name,
        };
      }
    } catch (error) {
      this.logger.warn({ error, address, chainId }, 'Failed to lookup token');
    }

    throw new Error(`Token not found: ${address} on chain ${chainId}`);
  }

  private createCurrency(
    address: string,
    chainId: ChainId,
    decimals: number,
    symbol?: string,
    name?: string
  ): Currency {
    // Check if native currency
    const NATIVE_ADDRESSES = [
      '0x0000000000000000000000000000000000000000',
      '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'
    ];

    if (NATIVE_ADDRESSES.some(addr =>
      addr.toLowerCase() === address.toLowerCase()
    )) {
      return nativeOnChain(chainId);
    }

    return new Token(
      chainId,
      address,
      decimals,
      symbol,
      name
    );
  }

  async getQuote(params: QuoteParams): Promise<SwapRoute | null> {
    const {
      tokenIn,
      tokenOut,
      tokenInDecimals,
      tokenOutDecimals,
      amount,
      chainId,
      type,
      recipient = '0x0000000000000000000000000000000000000001',
      slippageTolerance = 0.5,
      protocols = [Protocol.V3],
    } = params;

    const router = this.routers.get(chainId);
    if (!router) {
      throw new Error(`No router available for chain ${chainId}`);
    }

    // Create currencies using original addresses to properly handle native currency
    // The router will automatically handle native <-> wrapped token conversions
    const currencyIn = this.createCurrency(tokenIn, chainId, tokenInDecimals);
    const currencyOut = this.createCurrency(tokenOut, chainId, tokenOutDecimals);

    const currencyAmount = CurrencyAmount.fromRawAmount(
      currencyIn,
      JSBI.BigInt(amount)
    );

    const tradeType = type === 'exactIn'
      ? TradeType.EXACT_INPUT
      : TradeType.EXACT_OUTPUT;

    const swapConfig: SwapOptions = {
      recipient,
      slippageTolerance: new Percent(Math.round(slippageTolerance * 100), 10000),
      type: SwapType.SWAP_ROUTER_02,
      deadline: Math.floor(Date.now() / 1000) + 1800,
    };

    // Configure routing to enable multi-hop routes
    // Matches main branch DEFAULT_ROUTING_CONFIG_BY_CHAIN defaults
    const routingConfig: Partial<AlphaRouterConfig> = {
      protocols,
      v3PoolSelection: {
        topN: 2,
        topNDirectSwaps: 2,
        topNTokenInOut: 3,
        topNSecondHop: 1,
        topNWithEachBaseToken: 3,
        topNWithBaseToken: 5,
      },
      maxSwapsPerPath: 3,
      minSplits: 1,
      maxSplits: 7,
      distributionPercent: 5,
      forceCrossProtocol: false,
      // Citrea: Disable optimistic cached routes to avoid RPC gas limit errors
      // The RPC node has a 10M gas limit per eth_call, and optimistic cached routes
      // can trigger multicalls with 40+ quotes that exceed this limit
      ...(chainId === ChainId.CITREA_TESTNET ? { optimisticCachedRoutes: false } : {}),
    };

    try {
      this.logger.info({
        chainId,
        tokenIn,
        tokenOut,
        amount,
        type,
      }, 'Getting quote from AlphaRouter');

      const route = await router.route(
        currencyAmount,
        currencyOut,
        tradeType,
        swapConfig,
        routingConfig
      );

      if (route) {
        this.logger.info({
          quote: route.quote.toExact(),
          gasEstimate: route.estimatedGasUsed.toString(),
          routes: route.route.length,
        }, 'Quote obtained successfully');
      } else {
        this.logger.warn('No route found');
      }

      return route;
    } catch (error) {
      this.logger.error({
        error: error instanceof Error ? {
          message: error.message,
          stack: error.stack,
          name: error.name
        } : error
      }, 'Failed to get quote');
      throw error;
    }
  }

  async getSwap(params: SwapParams): Promise<SwapRoute | null> {
    const route = await this.getQuote(params);

    if (!route || !route.methodParameters) {
      return null;
    }

    // Route already contains methodParameters for executing swap
    return route;
  }

  async getGasPrices(chainId: ChainId): Promise<{
    maxFeePerGas: string;
    maxPriorityFeePerGas: string;
  }> {
    const provider = this.providers.get(chainId);
    if (!provider) {
      throw new Error(`No provider for chain ${chainId}`);
    }

    try {
      const feeData = await provider.getFeeData();

      if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
        return {
          maxFeePerGas: feeData.maxFeePerGas.toHexString(),
          maxPriorityFeePerGas: feeData.maxPriorityFeePerGas.toHexString(),
        };
      }

      // Fallback for non-EIP1559 chains
      const gasPrice = await provider.getGasPrice();
      const gasPriceWithBuffer = gasPrice.mul(120).div(100);

      return {
        maxFeePerGas: gasPriceWithBuffer.toHexString(),
        maxPriorityFeePerGas: gasPrice.mul(10).div(100).toHexString(),
      };
    } catch (error) {
      this.logger.error({ error }, 'Failed to fetch gas prices');
      // Return sensible defaults
      return {
        maxFeePerGas: '0x1dcd6500', // 500 gwei
        maxPriorityFeePerGas: '0x3b9aca00', // 1 gwei
      };
    }
  }

  getSupportedChains(): ChainId[] {
    return Array.from(this.routers.keys());
  }

  isChainSupported(chainId: ChainId): boolean {
    return this.routers.has(chainId);
  }

  getProvider(chainId: ChainId): providers.StaticJsonRpcProvider | undefined {
    return this.providers.get(chainId);
  }

  getV3PoolProvider(chainId: ChainId): V3PoolProvider | undefined {
    return this.v3PoolProviders.get(chainId);
  }
}