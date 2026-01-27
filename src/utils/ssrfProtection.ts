import dns from 'dns';
import { promisify } from 'util';

const dnsLookup = promisify(dns.lookup);

/**
 * SSRF Protection Utility
 * Validates URLs to prevent Server-Side Request Forgery attacks
 */

// Blocked hostnames - only actual hostnames, not IPs (IPs are checked separately in isIpInBlockedRange)
const BLOCKED_HOSTNAMES = new Set([
  // Localhost variants
  'localhost',
  'localhost.localdomain',

  // Cloud metadata hostnames
  'metadata.google.internal',    // GCP
  'metadata.goog',               // GCP alternative
  'metadata.azure.com',          // Azure

  // Kubernetes internal
  'kubernetes.default.svc',
  'kubernetes.default',
  'kubernetes',
]);

// Hostname suffixes that indicate internal/dangerous destinations
const BLOCKED_HOSTNAME_SUFFIXES = [
  // Localhost subdomains
  '.localhost',

  // Kubernetes internal DNS
  '.svc',
  '.svc.cluster.local',
  '.cluster.local',
  '.pod.cluster.local',

  // AWS internal DNS
  '.internal',
  '.ec2.internal',
  '.compute.internal',
  '.compute.amazonaws.com',

  // Wildcard DNS services that can resolve to ANY IP (including internal)
  // These are commonly used to bypass SSRF protections
  '.nip.io',
  '.sslip.io',
  '.xip.io',
  '.localtest.me',      // Resolves to 127.0.0.1
  '.lvh.me',            // Resolves to 127.0.0.1
  '.vcap.me',           // Resolves to 127.0.0.1
  '.lacolhost.com',     // Resolves to 127.0.0.1
  '.yoogle.com',        // Resolves to 127.0.0.1
];

// IP ranges that should be blocked (CIDR notation)
interface IpRange {
  start: bigint;
  end: bigint;
  name: string;
}

// Convert IP to BigInt for range comparison
function ipv4ToBigInt(ip: string): bigint {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) {
    throw new Error(`Invalid IPv4 address: ${ip}`);
  }
  return BigInt(parts[0]) * BigInt(16777216) +
         BigInt(parts[1]) * BigInt(65536) +
         BigInt(parts[2]) * BigInt(256) +
         BigInt(parts[3]);
}

// Parse CIDR notation to range
function cidrToRange(cidr: string): IpRange {
  const [ip, prefix] = cidr.split('/');
  const prefixNum = parseInt(prefix, 10);
  const ipBigInt = ipv4ToBigInt(ip);
  const mask = BigInt(2 ** 32) - BigInt(2 ** (32 - prefixNum));
  const start = ipBigInt & mask;
  const end = start + BigInt(2 ** (32 - prefixNum)) - BigInt(1);
  return { start, end, name: cidr };
}

// Blocked IP ranges
const BLOCKED_IP_RANGES: IpRange[] = [
  // Loopback
  cidrToRange('127.0.0.0/8'),
  // Private networks (RFC 1918)
  cidrToRange('10.0.0.0/8'),
  cidrToRange('172.16.0.0/12'),
  cidrToRange('192.168.0.0/16'),
  // Link-local (includes AWS metadata 169.254.169.254)
  cidrToRange('169.254.0.0/16'),
  // CGNAT
  cidrToRange('100.64.0.0/10'),
  // Broadcast
  cidrToRange('255.255.255.255/32'),
  // Current network
  cidrToRange('0.0.0.0/8'),
];

/**
 * Convert IPv4-mapped IPv6 hex format to IPv4 dotted decimal
 * e.g., ::ffff:a9fe:a9fe -> 169.254.169.254
 */
function ipv4MappedHexToIpv4(hexPart: string): string | null {
  // hexPart is like "a9fe:a9fe" (two 16-bit hex values)
  const parts = hexPart.split(':');
  if (parts.length !== 2) return null;

  try {
    const high = parseInt(parts[0], 16);
    const low = parseInt(parts[1], 16);
    if (isNaN(high) || isNaN(low)) return null;

    return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
  } catch {
    return null;
  }
}

/**
 * Check if an IP address falls within any blocked range
 */
function isIpInBlockedRange(ip: string): { blocked: boolean; reason?: string } {
  const lowerIp = ip.toLowerCase();

  // Check for IPv4-mapped IPv6 addresses in dotted-decimal (e.g., ::ffff:169.254.169.254)
  const ipv4MappedDottedMatch = lowerIp.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (ipv4MappedDottedMatch) {
    return isIpInBlockedRange(ipv4MappedDottedMatch[1]);
  }

  // Check for IPv4-mapped IPv6 addresses in hex format (e.g., ::ffff:a9fe:a9fe)
  // URL parser converts dotted-decimal to this format
  const ipv4MappedHexMatch = lowerIp.match(/^::ffff:([0-9a-f]{1,4}:[0-9a-f]{1,4})$/);
  if (ipv4MappedHexMatch) {
    const ipv4 = ipv4MappedHexToIpv4(ipv4MappedHexMatch[1]);
    if (ipv4) {
      return isIpInBlockedRange(ipv4);
    }
  }

  // Check for IPv6 loopback and private ranges
  if (lowerIp === '::1' ||
      lowerIp === '::' ||  // Unspecified address
      lowerIp.startsWith('fe80:') ||  // Link-local
      lowerIp.startsWith('fc') ||     // Unique local (fc00::/7)
      lowerIp.startsWith('fd')) {     // Unique local (fc00::/7)
    return { blocked: true, reason: 'IPv6 private/loopback address' };
  }

  // For IPv4 addresses
  try {
    const ipBigInt = ipv4ToBigInt(ip);

    for (const range of BLOCKED_IP_RANGES) {
      if (ipBigInt >= range.start && ipBigInt <= range.end) {
        return { blocked: true, reason: `IP in blocked range: ${range.name}` };
      }
    }
  } catch {
    // If it's not a valid IPv4, and not a recognized IPv6 private address, allow it
    // This handles IPv6 public addresses
  }

  return { blocked: false };
}

/**
 * Check if a hostname is explicitly blocked
 */
function isHostnameBlocked(hostname: string): boolean {
  const normalizedHostname = hostname.toLowerCase();

  // Check exact match against blocked hostnames
  if (BLOCKED_HOSTNAMES.has(normalizedHostname)) {
    return true;
  }

  // Check against blocked suffixes
  for (const suffix of BLOCKED_HOSTNAME_SUFFIXES) {
    if (normalizedHostname.endsWith(suffix)) {
      return true;
    }
  }

  return false;
}

export interface SsrfValidationResult {
  safe: boolean;
  url?: string;
  error?: string;
  resolvedIp?: string;
}

/**
 * Validates a URL against SSRF attacks
 * @param urlString - The URL to validate
 * @returns Validation result with safe status and any errors
 */
export async function validateUrlAgainstSsrf(urlString: string): Promise<SsrfValidationResult> {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(urlString);
  } catch {
    return { safe: false, error: 'Invalid URL format' };
  }

  // Only allow http and https protocols
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return { safe: false, error: `Disallowed protocol: ${parsedUrl.protocol}` };
  }

  const hostname = parsedUrl.hostname;

  // Check for explicitly blocked hostnames
  if (isHostnameBlocked(hostname)) {
    return { safe: false, error: `Blocked hostname: ${hostname}` };
  }

  // Check if hostname is an IP address
  const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
  const ipv6Regex = /^\[?([a-fA-F0-9:]+)\]?$/;

  if (ipv4Regex.test(hostname)) {
    const result = isIpInBlockedRange(hostname);
    if (result.blocked) {
      return { safe: false, error: result.reason };
    }
    return { safe: true, url: urlString, resolvedIp: hostname };
  }

  // Handle IPv6 addresses in URL (they come wrapped in brackets)
  const ipv6Match = hostname.match(ipv6Regex);
  if (ipv6Match) {
    const ipv6 = ipv6Match[1];
    const result = isIpInBlockedRange(ipv6);
    if (result.blocked) {
      return { safe: false, error: result.reason };
    }
    return { safe: true, url: urlString, resolvedIp: ipv6 };
  }

  // Resolve hostname to IP and check
  try {
    const { address } = await dnsLookup(hostname);

    const result = isIpInBlockedRange(address);
    if (result.blocked) {
      return {
        safe: false,
        error: `Hostname ${hostname} resolves to blocked IP: ${address} (${result.reason})`
      };
    }

    return { safe: true, url: urlString, resolvedIp: address };
  } catch (err: any) {
    // DNS resolution failed - could be a non-existent domain
    return { safe: false, error: `DNS resolution failed for ${hostname}: ${err.message}` };
  }
}

/**
 * Throws an error if the URL is not safe for server-side requests
 * @param urlString - The URL to validate
 * @throws Error if the URL fails SSRF validation
 */
export async function assertUrlSafeForSsrf(urlString: string): Promise<void> {
  const result = await validateUrlAgainstSsrf(urlString);
  if (!result.safe) {
    throw new Error(`SSRF protection: ${result.error}`);
  }
}
