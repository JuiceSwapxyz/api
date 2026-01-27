import { LightningAddress } from '@getalby/lightning-tools';
import { bech32 } from 'bech32';
import { assertUrlSafeForSsrf } from '../utils/ssrfProtection';

enum LnLikeAddressType {
  LIGHTNING_ADDRESS = 'lightning-address',
  LNURL = 'lnurl',
}

export class LightningService {
  constructor() {}

  /**
   * Validates Lightning address (user@domain.com) or LNURL
   * @throws Error if invalid format
   */
  validateLnLikeAddress(lnLikeAddress: string): { type: LnLikeAddressType, value: string, decoded?: string } {
    if (lnLikeAddress.includes('@')) {
      try {
        const lightningAddress = new LightningAddress(lnLikeAddress);
        if (!lightningAddress.username || !lightningAddress.domain) {
          throw new Error('Invalid Lightning address format');
        }
        return { type: LnLikeAddressType.LIGHTNING_ADDRESS, value: lnLikeAddress };
      } catch (error) {
        throw new Error('Invalid Lightning address format');
      }
    }
    
    if (lnLikeAddress.toLowerCase().startsWith('lnurl')) {
      try {
        const decoded = bech32.decode(lnLikeAddress.toLowerCase(), 2000);
        
        const words = decoded.words;
        const bytes = bech32.fromWords(words);
        const url = Buffer.from(bytes).toString('utf8');
        
        if (!url.startsWith('https://') && !url.startsWith('http://')) {
          throw new Error('LNURL must decode to a valid HTTP(S) URL');
        }
        
        new URL(url);
        
        return { type: LnLikeAddressType.LNURL, value: lnLikeAddress, decoded: url };
      } catch (error: any) {
        throw new Error(`Invalid LNURL format: ${error.message}`);
      }
    }
    
    throw new Error('Invalid Lightning address or LNURL format');
  }

  async createInvoice(amount: string, lnLikeAddress: string) {
    const validated = this.validateLnLikeAddress(lnLikeAddress);

    if (validated.type === LnLikeAddressType.LIGHTNING_ADDRESS) {
      // SSRF Protection: Validate the LNURL endpoint URL before fetching
      const [username, domain] = validated.value.split('@');
      const lnurlpUrl = `https://${domain}/.well-known/lnurlp/${username}`;
      await assertUrlSafeForSsrf(lnurlpUrl);

      const lightningAddress = new LightningAddress(validated.value, { proxy: false });
      await lightningAddress.fetch();

      // SSRF Protection: Validate callback URL from LNURL response before requesting invoice
      if (lightningAddress.lnurlpData?.callback) {
        await assertUrlSafeForSsrf(lightningAddress.lnurlpData.callback);
      }

      const invoice = await lightningAddress.requestInvoice({ satoshi: Number(amount) });
      return invoice;
    }
    if (validated.type === LnLikeAddressType.LNURL) {
        // SSRF Protection: Validate URL before making server-side request
        await assertUrlSafeForSsrf(validated.decoded!);

        const lnurlAddress = new LightningAddress(validated.value, { proxy: false });
        lnurlAddress.lnurlpUrl = () => validated.decoded!;
        await lnurlAddress.fetchLnurlData();

        // SSRF Protection: Validate callback URL from LNURL response before requesting invoice
        if (lnurlAddress.lnurlpData?.callback) {
          await assertUrlSafeForSsrf(lnurlAddress.lnurlpData.callback);
        }

        const invoice = await lnurlAddress.requestInvoice({ satoshi: Number(amount) });
        return invoice;
    }

    throw new Error("Invalid Lightning address or LNURL format");
  }
}