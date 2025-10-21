import axios from "axios";
import Logger from "bunyan";
import { providers, Contract } from "ethers";
import { NFTItem } from "./BalanceService";

export interface NftResponse {
  nfts: NFTItem[];
}

interface NFTMetadata {
  name?: string;
  description?: string;
  image?: string;
}

const KNOWN_NFTS = ["0xcF62B46fF36a6FcABf4C0056c535A0cA41E7c03b"];

// ERC721 ABI for NFT operations
const ERC721_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
];

export class NftService {
  private logger: Logger;
  private provider: providers.StaticJsonRpcProvider | undefined;
  private chainId: number;

  constructor(chainId: number, provider: providers.StaticJsonRpcProvider | undefined, logger: Logger) {
    this.chainId = chainId;
    this.provider = provider;
    this.logger = logger.child({ service: "NftService", chainId });
  }

  /**
   * Fetch NFTs owned by a wallet address
   * Uses RPC calls to check known contracts and fetch metadata from IPFS/HTTP
   */
  async fetchNfts(walletAddress: string): Promise<NftResponse> {
    const log = this.logger.child({ walletAddress, method: "fetchNfts" });
    log.debug("Fetching NFTs");

    if (!this.provider) {
      log.error("No provider available for RPC-based NFT fetching");
      return { nfts: [] };
    }

    return this.fetchNftsViaRPC(walletAddress);
  }

  private async fetchNftsViaRPC(walletAddress: string): Promise<NftResponse> {
    const log = this.logger.child({ walletAddress, method: "fetchNftsViaRPC" });

    try {
      const nfts: NFTItem[] = [];

      for (const contractAddress of KNOWN_NFTS) {
        try {
          const contract = new Contract(contractAddress, ERC721_ABI, this.provider);
          const balance = await contract.balanceOf(walletAddress);

          if (balance.gt(0)) {
            // We need to check token IDs up to a reasonable max, not just balance
            // Balance tells us HOW MANY NFTs, not WHICH token IDs
            // For example: user owns 1 NFT with tokenId=2, balance=1, but we'd only check tokenId=1
            const maxTokenIdToCheck = 1000; // Check up to 1000 token IDs
            let foundNfts = 0;

            for (let tokenId = 1; tokenId <= maxTokenIdToCheck && foundNfts < balance.toNumber(); tokenId++) {
              try {
                const owner = await contract.ownerOf(tokenId);

                if (owner.toLowerCase() === walletAddress.toLowerCase()) {
                  const nft = await this.fetchNFTMetadataViaRPC(contractAddress, tokenId.toString(), contract);

                  if (nft) {
                    nfts.push(nft);
                    foundNfts++;
                  }
                }
              } catch (err: any) {
                // Token doesn't exist or other error, continue checking
                log.debug({ error: err, tokenId }, "Error checking token ownership");
              }
            }
          }
        } catch (err: any) {
          log.debug({ error: err, contractAddress }, "Error checking known contract");
        }
      }

      log.debug({ nftCount: nfts.length }, "Fetched NFTs");
      return { nfts };
    } catch (error: any) {
      log.error({ error }, "Error fetching NFTs via RPC");
      return { nfts: [] };
    }
  }

  private async fetchMetadata(tokenURI: string, timeout = 3000): Promise<NFTMetadata | null> {
    try {
      if (tokenURI.startsWith("data:application/json")) {
        const base64Data = tokenURI.split(",")[1];
        if (base64Data) {
          const jsonString = Buffer.from(base64Data, "base64").toString();
          return JSON.parse(jsonString);
        }
      }

      let url = tokenURI;
      if (tokenURI.startsWith("ipfs://")) {
        url = tokenURI.replace("ipfs://", "https://ipfs.io/ipfs/");
      }

      if (url.startsWith("http://") || url.startsWith("https://")) {
        const response = await axios.get(url, {
          timeout,
          headers: {
            "User-Agent": "JuiceSwap-API/1.0",
            Accept: "application/json",
          },
        });
        return response.data;
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  private convertIPFSToHTTP(url: string | undefined): string | undefined {
    if (!url) return undefined;
    if (url.startsWith("ipfs://")) {
      return url.replace("ipfs://", "https://ipfs.io/ipfs/");
    }
    return url;
  }

  private async fetchNFTMetadataViaRPC(
    contractAddress: string,
    tokenId: string,
    contract: Contract
  ): Promise<NFTItem | null> {
    const log = this.logger.child({ contractAddress, tokenId, method: "fetchNFTMetadataViaRPC" });

    try {
      let tokenURI: string;
      try {
        tokenURI = await contract.tokenURI(tokenId);
      } catch (err) {
        log.debug("tokenURI call failed, skipping");
        return null;
      }

      let collectionName: string | undefined;
      try {
        collectionName = await contract.name();
      } catch (err) {
        // Optional
      }

      const metadata = await this.fetchMetadata(tokenURI);

      return {
        contractAddress,
        tokenId,
        chainId: this.chainId,
        name: metadata?.name || `#${tokenId}`,
        imageUrl: this.convertIPFSToHTTP(metadata?.image),
        description: metadata?.description,
        collectionName,
      };
    } catch (error) {
      log.debug({ error }, "Error fetching NFT metadata");
      return null;
    }
  }
}
