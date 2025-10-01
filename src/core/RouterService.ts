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
import { isNativeCurrency } from '@juiceswapxyz/universal-router-sdk';
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
  private logger: Logger;

  constructor(
    rpcProviders: Map<ChainId, providers.StaticJsonRpcProvider>,
    logger: Logger
  ) {
    this.providers = rpcProviders;
    this.logger = logger;
    this.routers = new Map();

    // Initialize routers for each chain with essential providers
    for (const [chainId, provider] of rpcProviders.entries()) {
      // Initialize multicall provider for efficient batching
      const multicallProvider = new UniswapMulticallProvider(
        chainId,
        provider,
        375000
      );

      // Initialize basic token provider
      const baseTokenProvider = new TokenProvider(chainId, multicallProvider);

      // Use caching wrapper with fallback
      const tokenCache = new NodeJSCache<Token>(
        new NodeCache({ stdTTL: 3600, checkperiod: 600 })
      );
      const tokenProvider = new CachingTokenProviderWithFallback(
        chainId,
        tokenCache,
        baseTokenProvider,
        baseTokenProvider
      );

      // Initialize V3 pool provider only - no V2 needed
      const v3PoolProvider = new V3PoolProvider(chainId, multicallProvider);

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

    // Simple native token replacement for routing
    const routingTokenIn = isNativeCurrency(tokenIn)
      ? nativeOnChain(chainId).wrapped.address
      : tokenIn;

    const routingTokenOut = isNativeCurrency(tokenOut)
      ? nativeOnChain(chainId).wrapped.address
      : tokenOut;

    const currencyIn = this.createCurrency(routingTokenIn, chainId, tokenInDecimals);
    const currencyOut = this.createCurrency(routingTokenOut, chainId, tokenOutDecimals);

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
    const routingConfig: Partial<AlphaRouterConfig> = {
      protocols,
      maxSwapsPerPath: 3, // Allow up to 3 hops
      maxSplits: 3, // Allow route splitting for better pricing
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
}