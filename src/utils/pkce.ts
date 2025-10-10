import crypto from 'crypto';

/**
 * PKCE (Proof Key for Code Exchange) Utilities
 * Used for secure OAuth 2.0 Authorization Code Flow
 */

/**
 * Generate a cryptographically random code verifier
 * Base64URL-encoded string, 43-128 characters
 */
export function generateCodeVerifier(): string {
  // Generate 32 random bytes (256 bits)
  const randomBytes = crypto.randomBytes(32);

  // Base64URL encode (URL-safe base64 without padding)
  return base64URLEncode(randomBytes);
}

/**
 * Generate code challenge from code verifier
 * SHA256 hash of verifier, then base64URL encoded
 */
export function generateCodeChallenge(codeVerifier: string): string {
  // SHA256 hash
  const hash = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest();

  // Base64URL encode
  return base64URLEncode(hash);
}

/**
 * Base64URL encode a buffer
 * Standard base64 but URL-safe (+ → -, / → _) and no padding (=)
 */
function base64URLEncode(buffer: Buffer): string {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Generate both verifier and challenge
 * Returns object with both values
 */
export function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  return {
    codeVerifier,
    codeChallenge,
  };
}

/**
 * Generate a random state token for CSRF protection
 */
export function generateState(): string {
  return crypto.randomBytes(32).toString('hex');
}
