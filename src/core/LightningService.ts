import { LightningAddress } from "@getalby/lightning-tools";
import { bech32 } from "bech32";

enum LnLikeAddressType {
  LIGHTNING_ADDRESS = "lightning-address",
  LNURL = "lnurl",
}

export class LightningService {
  constructor() {}

  /**
   * Validates Lightning address (user@domain.com) or LNURL
   * @throws Error if invalid format
   */
  validateLnLikeAddress(lnLikeAddress: string): {
    type: LnLikeAddressType;
    value: string;
    decoded?: string;
  } {
    if (lnLikeAddress.includes("@")) {
      try {
        const lightningAddress = new LightningAddress(lnLikeAddress);
        if (!lightningAddress.username || !lightningAddress.domain) {
          throw new Error("Invalid Lightning address format");
        }
        return {
          type: LnLikeAddressType.LIGHTNING_ADDRESS,
          value: lnLikeAddress,
        };
      } catch (error) {
        throw new Error("Invalid Lightning address format");
      }
    }

    if (lnLikeAddress.toLowerCase().startsWith("lnurl")) {
      try {
        const decoded = bech32.decode(lnLikeAddress.toLowerCase(), 2000);

        const words = decoded.words;
        const bytes = bech32.fromWords(words);
        const url = Buffer.from(bytes).toString("utf8");

        if (!url.startsWith("https://") && !url.startsWith("http://")) {
          throw new Error("LNURL must decode to a valid HTTP(S) URL");
        }

        new URL(url);

        return {
          type: LnLikeAddressType.LNURL,
          value: lnLikeAddress,
          decoded: url,
        };
      } catch (error: any) {
        throw new Error(`Invalid LNURL format: ${error.message}`);
      }
    }

    throw new Error("Invalid Lightning address or LNURL format");
  }
}
