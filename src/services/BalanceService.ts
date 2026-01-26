import { ethers, providers } from 'ethers';
import Logger from 'bunyan';
import { citreaTestnetTokenList } from '../config/citrea-testnet.tokenlist';

export interface TokenBalance {
  address: string;
  chainId: number;
  decimals: number;
  name: string;
  symbol: string;
  logoURI?: string;
  balance: string;
  balanceFormatted: string;
}

export interface NFTItem {
  contractAddress: string;
  tokenId: string;
  chainId: number;
  name?: string;
  imageUrl?: string;
  description?: string;
  collectionName?: string;
}

export interface PortfolioResponse {
  portfolio: {
    balances: TokenBalance[];
    nfts: NFTItem[];
  };
}

// ERC20 balanceOf ABI
const BALANCE_OF_ABI = ['function balanceOf(address owner) view returns (uint256)'];

// Native token placeholder
const NATIVE_ADDRESS = '0x0000000000000000000000000000000000000000';

export class BalanceService {
  private logger: Logger;
  private provider: providers.StaticJsonRpcProvider;
  private chainId: number;

  constructor(
    provider: providers.StaticJsonRpcProvider,
    chainId: number,
    logger: Logger
  ) {
    this.provider = provider;
    this.chainId = chainId;
    this.logger = logger.child({ service: 'BalanceService', chainId });
  }

  /**
   * Fetch all token balances for a wallet address
   * Uses efficient multicall batching to minimize RPC calls
   */
  async fetchBalances(walletAddress: string): Promise<PortfolioResponse> {
    const log = this.logger.child({ walletAddress, method: 'fetchBalances' });
    log.debug('Fetching portfolio balances');

    try {
      // Get token list for this chain
      const tokens = citreaTestnetTokenList.tokens.filter(
        (token) => token.chainId === this.chainId
      );

      if (tokens.length === 0) {
        log.warn('No tokens found for chain');
        return { portfolio: { balances: [], nfts: [] } };
      }

      // Fetch native balance
      const nativeBalance = await this.fetchNativeBalance(walletAddress);

      // Fetch all ERC20 balances in parallel
      const erc20Balances = await this.fetchERC20Balances(walletAddress, tokens);

      // Combine and filter out zero balances
      const allBalances = [nativeBalance, ...erc20Balances].filter(
        (balance) => balance.balance !== '0'
      );

      log.debug(
        { tokenCount: tokens.length, balanceCount: allBalances.length },
        'Successfully fetched balances'
      );

      return {
        portfolio: {
          balances: allBalances,
          nfts: [],
        },
      };
    } catch (error: any) {
      log.error({ error }, 'Error fetching balances');
      throw error;
    }
  }

  /**
   * Fetch native token balance (cBTC for Citrea)
   */
  private async fetchNativeBalance(walletAddress: string): Promise<TokenBalance> {
    try {
      const balance = await this.provider.getBalance(walletAddress);

      // Get native currency info from chain
      const nativeCurrency = this.getNativeCurrencyInfo();

      return {
        address: NATIVE_ADDRESS,
        chainId: this.chainId,
        decimals: nativeCurrency.decimals,
        name: nativeCurrency.name,
        symbol: nativeCurrency.symbol,
        logoURI: nativeCurrency.logoURI,
        balance: balance.toString(),
        balanceFormatted: ethers.utils.formatUnits(balance, nativeCurrency.decimals),
      };
    } catch (error) {
      this.logger.warn({ error, walletAddress }, 'Error fetching native balance');

      const nativeCurrency = this.getNativeCurrencyInfo();
      return {
        address: NATIVE_ADDRESS,
        chainId: this.chainId,
        decimals: nativeCurrency.decimals,
        name: nativeCurrency.name,
        symbol: nativeCurrency.symbol,
        logoURI: nativeCurrency.logoURI,
        balance: '0',
        balanceFormatted: '0',
      };
    }
  }

  /**
   * Fetch ERC20 token balances using batched calls
   */
  private async fetchERC20Balances(
    walletAddress: string,
    tokens: any[]
  ): Promise<TokenBalance[]> {
    const log = this.logger.child({ method: 'fetchERC20Balances' });

    try {
      // Create balance check promises for all tokens
      const balancePromises = tokens.map(async (token) => {
        try {
          const contract = new ethers.Contract(token.address, BALANCE_OF_ABI, this.provider);
          const balance = await contract.balanceOf(walletAddress);

          return {
            address: token.address,
            chainId: token.chainId,
            decimals: token.decimals,
            name: token.name,
            symbol: token.symbol,
            logoURI: token.logoURI || '',
            balance: balance.toString(),
            balanceFormatted: ethers.utils.formatUnits(balance, token.decimals),
          };
        } catch (error) {
          // If individual token fails, log and return zero balance
          log.debug({ error, token: token.symbol }, 'Error fetching token balance');
          return {
            address: token.address,
            chainId: token.chainId,
            decimals: token.decimals,
            name: token.name,
            symbol: token.symbol,
            logoURI: token.logoURI || '',
            balance: '0',
            balanceFormatted: '0',
          };
        }
      });

      // Execute all balance checks in parallel
      const balances = await Promise.all(balancePromises);

      log.debug({ tokenCount: balances.length }, 'Fetched ERC20 balances');

      return balances;
    } catch (error) {
      log.error({ error }, 'Error in fetchERC20Balances');
      return [];
    }
  }

  /**
   * Get native currency info for the chain
   */
  private getNativeCurrencyInfo() {
    // For Citrea Testnet
    if (this.chainId === 5115) {
      return {
        name: 'Citrea BTC',
        symbol: 'cBTC',
        decimals: 18,
        logoURI: '',
      };
    }

    if (this.chainId === 4114) {
      return {
        name: 'Citrea BTC',
        symbol: 'cBTC',
        decimals: 18,
        logoURI: '',
      };
    }
    
    // Default fallback
    return {
      name: 'Ether',
      symbol: 'ETH',
      decimals: 18,
      logoURI: '',
    };
  }
}
