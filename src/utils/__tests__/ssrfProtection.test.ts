import { validateUrlAgainstSsrf, assertUrlSafeForSsrf } from '../ssrfProtection';

describe('ssrfProtection utilities', () => {
  describe('validateUrlAgainstSsrf', () => {
    describe('should BLOCK dangerous URLs', () => {
      // Localhost variants
      it('should block localhost', async () => {
        const result = await validateUrlAgainstSsrf('http://localhost/api');
        expect(result.safe).toBe(false);
        expect(result.error).toContain('Blocked hostname');
      });

      it('should block localhost with port', async () => {
        const result = await validateUrlAgainstSsrf('http://localhost:8080/api');
        expect(result.safe).toBe(false);
        expect(result.error).toContain('Blocked hostname');
      });

      it('should block 127.0.0.1', async () => {
        const result = await validateUrlAgainstSsrf('http://127.0.0.1/api');
        expect(result.safe).toBe(false);
        // Can be blocked as hostname or IP range - either is correct
        expect(result.error).toBeDefined();
      });

      it('should block 127.x.x.x range', async () => {
        const result = await validateUrlAgainstSsrf('http://127.255.255.255/api');
        expect(result.safe).toBe(false);
        expect(result.error).toContain('127.0.0.0/8');
      });

      // AWS metadata endpoint (critical)
      it('should block AWS metadata endpoint 169.254.169.254', async () => {
        const result = await validateUrlAgainstSsrf('http://169.254.169.254/latest/meta-data/');
        expect(result.safe).toBe(false);
        // Can be blocked as hostname or IP range - either is correct
        expect(result.error).toBeDefined();
      });

      it('should block AWS metadata with IAM credentials path', async () => {
        const result = await validateUrlAgainstSsrf('http://169.254.169.254/latest/meta-data/iam/security-credentials/');
        expect(result.safe).toBe(false);
        // Can be blocked as hostname or IP range - either is correct
        expect(result.error).toBeDefined();
      });

      // Private IP ranges (RFC 1918)
      it('should block 10.x.x.x private range', async () => {
        const result = await validateUrlAgainstSsrf('http://10.0.0.1/api');
        expect(result.safe).toBe(false);
        expect(result.error).toContain('10.0.0.0/8');
      });

      it('should block 10.255.255.255', async () => {
        const result = await validateUrlAgainstSsrf('http://10.255.255.255/api');
        expect(result.safe).toBe(false);
        expect(result.error).toContain('10.0.0.0/8');
      });

      it('should block 172.16.x.x private range', async () => {
        const result = await validateUrlAgainstSsrf('http://172.16.0.1/api');
        expect(result.safe).toBe(false);
        expect(result.error).toContain('172.16.0.0/12');
      });

      it('should block 172.31.255.255 (end of 172.16/12 range)', async () => {
        const result = await validateUrlAgainstSsrf('http://172.31.255.255/api');
        expect(result.safe).toBe(false);
        expect(result.error).toContain('172.16.0.0/12');
      });

      it('should block 192.168.x.x private range', async () => {
        const result = await validateUrlAgainstSsrf('http://192.168.1.1/api');
        expect(result.safe).toBe(false);
        expect(result.error).toContain('192.168.0.0/16');
      });

      it('should block 192.168.255.255', async () => {
        const result = await validateUrlAgainstSsrf('http://192.168.255.255/api');
        expect(result.safe).toBe(false);
        expect(result.error).toContain('192.168.0.0/16');
      });

      // Link-local addresses
      it('should block link-local 169.254.1.1', async () => {
        const result = await validateUrlAgainstSsrf('http://169.254.1.1/api');
        expect(result.safe).toBe(false);
        expect(result.error).toContain('169.254.0.0/16');
      });

      // Explicitly blocked hostnames
      it('should block 0.0.0.0', async () => {
        const result = await validateUrlAgainstSsrf('http://0.0.0.0/api');
        expect(result.safe).toBe(false);
        // Blocked by IP range check (0.0.0.0/8), not hostname list
        expect(result.error).toBeDefined();
      });

      it('should block metadata.google.internal', async () => {
        const result = await validateUrlAgainstSsrf('http://metadata.google.internal/computeMetadata/v1/');
        expect(result.safe).toBe(false);
        expect(result.error).toContain('Blocked hostname');
      });

      it('should block kubernetes.default.svc', async () => {
        const result = await validateUrlAgainstSsrf('http://kubernetes.default.svc/api/v1/secrets');
        expect(result.safe).toBe(false);
        expect(result.error).toContain('Blocked hostname');
      });

      it('should block .internal domains (AWS internal DNS)', async () => {
        const result = await validateUrlAgainstSsrf('http://ip-10-0-0-1.ec2.internal/');
        expect(result.safe).toBe(false);
        expect(result.error).toContain('Blocked hostname');
      });

      it('should block .cluster.local (Kubernetes)', async () => {
        const result = await validateUrlAgainstSsrf('http://my-service.default.svc.cluster.local/');
        expect(result.safe).toBe(false);
        expect(result.error).toContain('Blocked hostname');
      });

      // CGNAT range
      it('should block CGNAT range 100.64.0.0/10', async () => {
        const result = await validateUrlAgainstSsrf('http://100.64.0.1/api');
        expect(result.safe).toBe(false);
        expect(result.error).toContain('100.64.0.0/10');
      });

      // Protocol restrictions
      it('should block file:// protocol', async () => {
        const result = await validateUrlAgainstSsrf('file:///etc/passwd');
        expect(result.safe).toBe(false);
        expect(result.error).toContain('Disallowed protocol');
      });

      it('should block ftp:// protocol', async () => {
        const result = await validateUrlAgainstSsrf('ftp://ftp.example.com/file');
        expect(result.safe).toBe(false);
        expect(result.error).toContain('Disallowed protocol');
      });

      it('should block gopher:// protocol', async () => {
        const result = await validateUrlAgainstSsrf('gopher://evil.com/1');
        expect(result.safe).toBe(false);
        expect(result.error).toContain('Disallowed protocol');
      });

      // Invalid URLs
      it('should reject invalid URL format', async () => {
        const result = await validateUrlAgainstSsrf('not-a-url');
        expect(result.safe).toBe(false);
        expect(result.error).toContain('Invalid URL format');
      });

      // IPv6 loopback
      it('should block IPv6 loopback ::1', async () => {
        const result = await validateUrlAgainstSsrf('http://[::1]/api');
        expect(result.safe).toBe(false);
        expect(result.error).toContain('IPv6 private/loopback');
      });

      // IPv4-mapped IPv6 addresses (bypass attempt)
      it('should block IPv4-mapped IPv6 for AWS metadata (::ffff:169.254.169.254)', async () => {
        const result = await validateUrlAgainstSsrf('http://[::ffff:169.254.169.254]/latest/meta-data/');
        expect(result.safe).toBe(false);
      });

      it('should block IPv4-mapped IPv6 for localhost (::ffff:127.0.0.1)', async () => {
        const result = await validateUrlAgainstSsrf('http://[::ffff:127.0.0.1]/api');
        expect(result.safe).toBe(false);
      });

      it('should block IPv4-mapped IPv6 for private range (::ffff:10.0.0.1)', async () => {
        const result = await validateUrlAgainstSsrf('http://[::ffff:10.0.0.1]/api');
        expect(result.safe).toBe(false);
      });

      // IPv6 unspecified address
      it('should block IPv6 unspecified address (::)', async () => {
        const result = await validateUrlAgainstSsrf('http://[::]/api');
        expect(result.safe).toBe(false);
        expect(result.error).toContain('IPv6 private/loopback');
      });

      // Wildcard DNS services (SSRF bypass techniques)
      it('should block nip.io wildcard DNS (127.0.0.1.nip.io)', async () => {
        const result = await validateUrlAgainstSsrf('http://127.0.0.1.nip.io/api');
        expect(result.safe).toBe(false);
        expect(result.error).toContain('Blocked hostname');
      });

      it('should block sslip.io wildcard DNS (169-254-169-254.sslip.io)', async () => {
        const result = await validateUrlAgainstSsrf('http://169-254-169-254.sslip.io/latest/meta-data/');
        expect(result.safe).toBe(false);
        expect(result.error).toContain('Blocked hostname');
      });

      it('should block xip.io wildcard DNS', async () => {
        const result = await validateUrlAgainstSsrf('http://10.0.0.1.xip.io/api');
        expect(result.safe).toBe(false);
        expect(result.error).toContain('Blocked hostname');
      });

      it('should block localtest.me (resolves to 127.0.0.1)', async () => {
        const result = await validateUrlAgainstSsrf('http://foo.localtest.me/api');
        expect(result.safe).toBe(false);
        expect(result.error).toContain('Blocked hostname');
      });

      it('should block lvh.me (resolves to 127.0.0.1)', async () => {
        const result = await validateUrlAgainstSsrf('http://sub.lvh.me/api');
        expect(result.safe).toBe(false);
        expect(result.error).toContain('Blocked hostname');
      });

      it('should block AWS compute hostnames', async () => {
        const result = await validateUrlAgainstSsrf('http://ip-10-0-0-1.compute.amazonaws.com/');
        expect(result.safe).toBe(false);
        expect(result.error).toContain('Blocked hostname');
      });

      it('should block Kubernetes pod DNS', async () => {
        const result = await validateUrlAgainstSsrf('http://10-0-0-1.default.pod.cluster.local/');
        expect(result.safe).toBe(false);
        expect(result.error).toContain('Blocked hostname');
      });
    });

    describe('should ALLOW safe URLs', () => {
      it('should allow public IP addresses like 8.8.8.8', async () => {
        // Direct IP - no DNS resolution needed
        const result = await validateUrlAgainstSsrf('http://8.8.8.8/dns-query');
        expect(result.safe).toBe(true);
        expect(result.resolvedIp).toBe('8.8.8.8');
      });

      it('should allow 172.32.0.1 (just outside 172.16/12 range)', async () => {
        // Direct IP - no DNS resolution needed
        const result = await validateUrlAgainstSsrf('http://172.32.0.1/api');
        expect(result.safe).toBe(true);
        expect(result.resolvedIp).toBe('172.32.0.1');
      });

      it('should allow 100.63.255.255 (just before CGNAT range)', async () => {
        const result = await validateUrlAgainstSsrf('http://100.63.255.255/api');
        expect(result.safe).toBe(true);
      });

      it('should allow 100.128.0.0 (just after CGNAT range)', async () => {
        const result = await validateUrlAgainstSsrf('http://100.128.0.0/api');
        expect(result.safe).toBe(true);
      });

      it('should allow public domains when DNS resolves to public IP', async () => {
        // example.com reliably resolves to 93.184.215.14 (public)
        const result = await validateUrlAgainstSsrf('http://example.com/api');
        // If DNS resolution succeeds, it should be safe; if it fails, we accept that too in CI
        if (result.safe) {
          expect(result.resolvedIp).toBeDefined();
        } else {
          expect(result.error).toContain('DNS resolution failed');
        }
      });
    });

    describe('edge cases', () => {
      it('should handle URLs with query parameters', async () => {
        const result = await validateUrlAgainstSsrf('http://169.254.169.254/latest?token=abc');
        expect(result.safe).toBe(false);
      });

      it('should handle URLs with fragments', async () => {
        const result = await validateUrlAgainstSsrf('http://192.168.1.1/page#section');
        expect(result.safe).toBe(false);
      });

      it('should be case-insensitive for hostnames', async () => {
        const result = await validateUrlAgainstSsrf('http://LOCALHOST/api');
        expect(result.safe).toBe(false);
      });

      it('should handle URLs with authentication credentials', async () => {
        const result = await validateUrlAgainstSsrf('http://user:pass@localhost/api');
        expect(result.safe).toBe(false);
      });
    });
  });

  describe('assertUrlSafeForSsrf', () => {
    it('should not throw for safe URLs', async () => {
      await expect(assertUrlSafeForSsrf('https://example.com/api')).resolves.not.toThrow();
    });

    it('should throw for dangerous URLs', async () => {
      await expect(assertUrlSafeForSsrf('http://169.254.169.254/latest/meta-data/')).rejects.toThrow('SSRF protection');
    });

    it('should throw for localhost', async () => {
      await expect(assertUrlSafeForSsrf('http://localhost/api')).rejects.toThrow('SSRF protection');
    });

    it('should throw for private IPs', async () => {
      await expect(assertUrlSafeForSsrf('http://10.0.0.1/api')).rejects.toThrow('SSRF protection');
    });
  });
});
