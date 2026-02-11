import { Request, Response } from "express";
import jwt from "jsonwebtoken";
import { verifyMessage } from "viem";
import NodeCache from "node-cache";
import { v4 as uuidv4 } from "uuid";
import Logger from "bunyan";
import { JWT_SECRET } from "../middleware/auth";

// Nonce cache: 5 minute TTL, check for expired entries every 60s
const nonceCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";

/** Parse duration string like "24h", "7d", "30m" into seconds */
function parseExpiresIn(val: string): number {
  const match = val.match(/^(\d+)(s|m|h|d)$/);
  if (!match) return 86400; // default 24h
  const num = parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case "s":
      return num;
    case "m":
      return num * 60;
    case "h":
      return num * 3600;
    case "d":
      return num * 86400;
    default:
      return 86400;
  }
}

/**
 * GET /v1/auth/nonce?address=0x...
 * Returns a one-time nonce for the wallet to sign.
 */
export function createNonceHandler(logger: Logger) {
  return async (req: Request, res: Response) => {
    try {
      const address = (req.query.address as string)?.toLowerCase();
      if (!address) {
        res.status(400).json({ error: "address query parameter is required" });
        return;
      }

      const nonce = uuidv4();
      const message = `Sign this message to authenticate with JuiceSwap.\n\nNonce: ${nonce}`;

      // Store nonce keyed by address (overwrites any existing nonce)
      nonceCache.set(address, { nonce, message });

      logger.debug({ address }, "Auth nonce generated");
      res.json({ message, nonce });
    } catch (error: any) {
      logger.error({ error: error.message }, "Failed to generate nonce");
      res.status(500).json({ error: "Failed to generate nonce" });
    }
  };
}

/**
 * POST /v1/auth/verify
 * Body: { address: "0x...", signature: "0x..." }
 * Verifies the wallet signature against the stored nonce, returns a JWT.
 */
export function createVerifyHandler(logger: Logger) {
  return async (req: Request, res: Response) => {
    try {
      const { address, signature } = req.body;
      const lowerAddress = address.toLowerCase();

      // Retrieve and consume the nonce
      const stored = nonceCache.get<{ nonce: string; message: string }>(
        lowerAddress,
      );
      if (!stored) {
        res.status(400).json({
          error: "Nonce not found or expired",
          detail: "Request a new nonce via GET /v1/auth/nonce",
        });
        return;
      }

      // Consume nonce immediately (one-time use)
      nonceCache.del(lowerAddress);

      // Verify the signature using viem
      const valid = await verifyMessage({
        address: address as `0x${string}`,
        message: stored.message,
        signature: signature as `0x${string}`,
      });

      if (!valid) {
        logger.warn({ address: lowerAddress }, "Invalid wallet signature");
        res.status(401).json({ error: "Invalid signature" });
        return;
      }

      // Issue JWT
      const expiresInSeconds = parseExpiresIn(JWT_EXPIRES_IN);
      const token = jwt.sign({ address: lowerAddress }, JWT_SECRET, {
        expiresIn: expiresInSeconds,
      });

      logger.info({ address: lowerAddress }, "Wallet authenticated");
      res.json({ token, expiresIn: JWT_EXPIRES_IN });
    } catch (error: any) {
      logger.error({ error: error.message }, "Auth verification failed");
      res.status(500).json({ error: "Verification failed" });
    }
  };
}

/**
 * GET /v1/auth/me
 * Returns the authenticated wallet address. Requires valid JWT.
 */
export function createMeHandler() {
  return (req: Request, res: Response) => {
    res.json({ address: req.user!.address });
  };
}
