import axios, { AxiosError } from "axios";
import Logger from "bunyan";
import FormData from "form-data";

const PINATA_API_URL = "https://api.pinata.cloud";

interface PinataResponse {
  IpfsHash: string;
  PinSize: number;
  Timestamp: string;
}

export interface TokenMetadata {
  name: string;
  description: string;
  image: string;
  external_url?: string;
  attributes?: Array<{
    trait_type: string;
    value: string;
  }>;
}

export class PinataService {
  private apiKey: string;
  private secretKey: string;
  private logger: Logger;

  constructor(logger: Logger) {
    const apiKey = process.env.PINATA_API_KEY;
    const secretKey = process.env.PINATA_SECRET_KEY;

    if (!apiKey || !secretKey) {
      throw new Error("PINATA_API_KEY and PINATA_SECRET_KEY must be set");
    }

    this.apiKey = apiKey;
    this.secretKey = secretKey;
    this.logger = logger.child({ service: "PinataService" });
  }

  /**
   * Upload a file (image) to IPFS via Pinata
   * @param file - Buffer containing file data
   * @param filename - Original filename
   * @param mimeType - File MIME type
   * @returns ipfs:// prefixed URI
   */
  async uploadFile(
    file: Buffer,
    filename: string,
    mimeType: string,
  ): Promise<string> {
    const log = this.logger.child({ method: "uploadFile", filename, mimeType });

    try {
      const formData = new FormData();
      formData.append("file", file, {
        filename,
        contentType: mimeType,
      });

      // Add pinata metadata for better organization
      const metadata = JSON.stringify({
        name: filename,
        keyvalues: {
          type: "launchpad-token-image",
          uploadedAt: new Date().toISOString(),
        },
      });
      formData.append("pinataMetadata", metadata);

      const response = await axios.post<PinataResponse>(
        `${PINATA_API_URL}/pinning/pinFileToIPFS`,
        formData,
        {
          maxBodyLength: Infinity,
          headers: {
            ...formData.getHeaders(),
            pinata_api_key: this.apiKey,
            pinata_secret_api_key: this.secretKey,
          },
        },
      );

      const ipfsHash = response.data.IpfsHash;
      const uri = `ipfs://${ipfsHash}`;

      log.info({ ipfsHash, uri }, "File uploaded to IPFS");
      return uri;
    } catch (error) {
      this.handleError(error, log, "Failed to upload file to IPFS");
      throw error;
    }
  }

  /**
   * Upload JSON metadata to IPFS via Pinata
   * @param data - Object to serialize as JSON
   * @param name - Name for the pin (for Pinata dashboard)
   * @returns ipfs:// prefixed URI
   */
  async uploadJSON(data: TokenMetadata, name: string): Promise<string> {
    const log = this.logger.child({ method: "uploadJSON", pinName: name });

    try {
      const response = await axios.post<PinataResponse>(
        `${PINATA_API_URL}/pinning/pinJSONToIPFS`,
        {
          pinataContent: data,
          pinataMetadata: {
            name,
            keyvalues: {
              type: "launchpad-token-metadata",
              uploadedAt: new Date().toISOString(),
            },
          },
        },
        {
          headers: {
            "Content-Type": "application/json",
            pinata_api_key: this.apiKey,
            pinata_secret_api_key: this.secretKey,
          },
        },
      );

      const ipfsHash = response.data.IpfsHash;
      const uri = `ipfs://${ipfsHash}`;

      log.info({ ipfsHash, uri, name }, "JSON metadata uploaded to IPFS");
      return uri;
    } catch (error) {
      this.handleError(error, log, "Failed to upload JSON to IPFS");
      throw error;
    }
  }

  /**
   * Test Pinata connection
   */
  async testConnection(): Promise<boolean> {
    const log = this.logger.child({ method: "testConnection" });

    try {
      await axios.get(`${PINATA_API_URL}/data/testAuthentication`, {
        headers: {
          pinata_api_key: this.apiKey,
          pinata_secret_api_key: this.secretKey,
        },
      });
      log.info("Pinata connection verified");
      return true;
    } catch (error) {
      log.error({ error }, "Pinata connection failed");
      return false;
    }
  }

  private handleError(error: unknown, log: Logger, message: string): void {
    if (error instanceof AxiosError) {
      log.error(
        {
          status: error.response?.status,
          data: error.response?.data,
          message: error.message,
        },
        message,
      );
    } else {
      log.error({ error }, message);
    }
  }
}

// Singleton instance
let pinataServiceInstance: PinataService | null = null;

export function getPinataService(logger: Logger): PinataService {
  if (!pinataServiceInstance) {
    pinataServiceInstance = new PinataService(logger);
  }
  return pinataServiceInstance;
}
