import Logger from "bunyan";

export interface EvmLockup {
  id: string;
  preimageHash: string;
  chainId: number;
  amount: string;
  claimAddress: string;
  refundAddress: string;
  timelock: number;
  tokenAddress: string;
  swapType: string;
  claimed: boolean;
  refunded: boolean;
  claimTxHash: string | null;
  refundTxHash: string | null;
  lockupTxHash: string | null;
  preimage: string | null;
  knownPreimage?: { preimage: string } | null;
}

const EVM_BRIDGE_INDEXER_URL = "https://lightning.space/v1/claim";

const LockupFragment = `
  id
  preimageHash
  chainId
  amount
  claimAddress
  refundAddress
  timelock
  tokenAddress
  swapType
  claimed
  refunded
  claimTxHash
  refundTxHash
  lockupTxHash
  preimage
`;

export class EvmBridgeIndexer {
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  async query(query: string, variables: any) {
    const res = await fetch(EVM_BRIDGE_INDEXER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });

    if (!res.ok) {
      this.logger.warn({ res }, "Failed to query EvmBridgeIndexer");
      throw new Error(`Failed to query EvmBridgeIndexer: ${res.statusText}`);
    }

    return await res.json();
  }

  async getLockup(preimageHash: string, chainId: number) {
    const data = await this.query(
      `query GetLockup($preimageHash: String = "", $chainId: Int = 0) {
        lockupss(where: { preimageHash: $preimageHash, chainId: $chainId }) {
          items {
            ${LockupFragment}
          }
        }
      }`,
      { preimageHash, chainId },
    );
    return data?.lockupss?.items ?? [];
  }

  async getEvmBrigeLockups(
    preimageHash: string,
    originChainId: number,
    destinationChainId: number,
  ) {
    const data = await this.query(
      `query EvmBridgeLockups($originLockup: String = "", $destinationLockup: String = "") {
        originLockup: lockups(id: $originLockup) {
          ${LockupFragment}
        }
        destinationLockup: lockups(id: $destinationLockup) {
          ${LockupFragment}
        }
      }`,
      {
        originLockup: `${originChainId}:${preimageHash}`,
        destinationLockup: `${destinationChainId}:${preimageHash}`,
      },
    );

    return {
      originLockup: data?.originLockup,
      destinationLockup: data?.destinationLockup,
    };
  }

  async getClaimableAndRefundableLockups(
    address: string,
  ): Promise<{ refundable: EvmLockup[]; claimable: EvmLockup[] }> {
    if (!address) {
      return { refundable: [], claimable: [] };
    }

    const data = await this.query(
      `query ClaimableAndRefundable($address: String = "") {
        refundable: lockupss(
          where: { refundAddress: $address, refundTxHash: null, claimed: false }
          orderBy: "timelock"
          orderDirection: "asc"
          limit: 1000
        ) {
          items {
            ${LockupFragment}
          }
        }
        claimable: lockupss(
          where: { claimAddress: $address, claimTxHash: null, claimed: false, refunded: false }
          orderBy: "timelock"
          orderDirection: "asc"
          limit: 1000
        ) {
          items {
            ${LockupFragment}
            knownPreimage {
              preimage
            }
          }
        }
      }`,
      { address: address.toLowerCase() },
    );

    return {
      refundable: data?.data?.refundable?.items ?? [],
      claimable: data?.data?.claimable?.items ?? [],
    };
  }
}
