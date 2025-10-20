import type { Request } from "express";
import { createHash } from "crypto";

/**
 * Extracts the client's IP address from an Express request.
 * Handles X-Forwarded-For, X-Real-IP headers, and direct socket connections.
 *
 * Priority order:
 * 1. X-Forwarded-For header (for proxied requests) - takes first IP in chain
 * 2. X-Real-IP header (alternative proxy header)
 * 3. request.ip (Express built-in, handles socket.remoteAddress)
 *
 * @param request - Express request object
 * @returns IP address string, or undefined if unable to determine
 */
export function extractIpAddress(request: Request): string | undefined {
  // Check X-Forwarded-For header (comma-separated list, leftmost is client IP)
  const forwardedFor = request.headers["x-forwarded-for"];
  if (forwardedFor) {
    if (typeof forwardedFor === "string") {
      const firstIp = forwardedFor.split(",")[0]?.trim();
      if (firstIp) {
        return firstIp;
      }
    } else if (Array.isArray(forwardedFor) && forwardedFor.length > 0) {
      const firstIp = forwardedFor[0]?.trim();
      if (firstIp) {
        return firstIp;
      }
    }
  }

  // Check X-Real-IP header
  const realIp = request.headers["x-real-ip"];
  if (realIp && typeof realIp === "string") {
    return realIp;
  }

  // Fallback to Express's built-in IP detection
  return request.ip;
}

/**
 * Hashes an IP address using SHA-256 for privacy-preserving storage.
 * This allows tracking unique users without storing personally identifiable information.
 *
 * @param ipAddress - The IP address to hash
 * @returns SHA-256 hash of the IP address, or undefined if input is undefined or empty
 */
export function hashIpAddress(ipAddress: string | undefined): string | undefined {
  if (!ipAddress || ipAddress.trim() === '') {
    return undefined;
  }

  return createHash("sha256").update(ipAddress).digest("hex");
}
