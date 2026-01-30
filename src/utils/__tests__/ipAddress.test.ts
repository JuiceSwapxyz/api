import { Request } from "express";
import { extractIpAddress, hashIpAddress } from "../ipAddress";

describe("ipAddress utilities", () => {
  describe("extractIpAddress", () => {
    it("should extract IP from X-Forwarded-For header (string)", () => {
      const mockRequest = {
        headers: {
          "x-forwarded-for": "203.0.113.195, 70.41.3.18, 150.172.238.178",
        },
        ip: "192.168.1.1",
      } as unknown as Request;

      const result = extractIpAddress(mockRequest);
      expect(result).toBe("203.0.113.195");
    });

    it("should extract IP from X-Forwarded-For header (array)", () => {
      const mockRequest = {
        headers: {
          "x-forwarded-for": ["198.51.100.42", "203.0.113.7"],
        },
        ip: "192.168.1.1",
      } as unknown as Request;

      const result = extractIpAddress(mockRequest);
      expect(result).toBe("198.51.100.42");
    });

    it("should handle X-Forwarded-For with whitespace", () => {
      const mockRequest = {
        headers: {
          "x-forwarded-for": "  203.0.113.195  , 70.41.3.18",
        },
        ip: "192.168.1.1",
      } as unknown as Request;

      const result = extractIpAddress(mockRequest);
      expect(result).toBe("203.0.113.195");
    });

    it("should extract IP from X-Real-IP header when X-Forwarded-For is missing", () => {
      const mockRequest = {
        headers: {
          "x-real-ip": "198.51.100.123",
        },
        ip: "192.168.1.1",
      } as unknown as Request;

      const result = extractIpAddress(mockRequest);
      expect(result).toBe("198.51.100.123");
    });

    it("should fallback to request.ip when headers are missing", () => {
      const mockRequest = {
        headers: {},
        ip: "192.168.1.100",
      } as unknown as Request;

      const result = extractIpAddress(mockRequest);
      expect(result).toBe("192.168.1.100");
    });

    it("should prioritize X-Forwarded-For over X-Real-IP", () => {
      const mockRequest = {
        headers: {
          "x-forwarded-for": "203.0.113.195",
          "x-real-ip": "198.51.100.123",
        },
        ip: "192.168.1.1",
      } as unknown as Request;

      const result = extractIpAddress(mockRequest);
      expect(result).toBe("203.0.113.195");
    });

    it("should prioritize X-Real-IP over request.ip", () => {
      const mockRequest = {
        headers: {
          "x-real-ip": "198.51.100.123",
        },
        ip: "192.168.1.1",
      } as unknown as Request;

      const result = extractIpAddress(mockRequest);
      expect(result).toBe("198.51.100.123");
    });

    it("should return undefined when no IP is available", () => {
      const mockRequest = {
        headers: {},
        ip: undefined,
      } as unknown as Request;

      const result = extractIpAddress(mockRequest);
      expect(result).toBeUndefined();
    });

    it("should handle empty X-Forwarded-For string", () => {
      const mockRequest = {
        headers: {
          "x-forwarded-for": "",
        },
        ip: "192.168.1.1",
      } as unknown as Request;

      const result = extractIpAddress(mockRequest);
      expect(result).toBe("192.168.1.1");
    });

    it("should handle empty X-Forwarded-For array", () => {
      const mockRequest = {
        headers: {
          "x-forwarded-for": [],
        },
        ip: "192.168.1.1",
      } as unknown as Request;

      const result = extractIpAddress(mockRequest);
      expect(result).toBe("192.168.1.1");
    });

    it("should handle IPv6 addresses in X-Forwarded-For", () => {
      const mockRequest = {
        headers: {
          "x-forwarded-for": "2001:0db8:85a3:0000:0000:8a2e:0370:7334",
        },
        ip: "192.168.1.1",
      } as unknown as Request;

      const result = extractIpAddress(mockRequest);
      expect(result).toBe("2001:0db8:85a3:0000:0000:8a2e:0370:7334");
    });

    it("should handle non-string X-Real-IP header", () => {
      const mockRequest = {
        headers: {
          "x-real-ip": ["198.51.100.123"],
        },
        ip: "192.168.1.1",
      } as unknown as Request;

      const result = extractIpAddress(mockRequest);
      expect(result).toBe("192.168.1.1");
    });
  });

  describe("hashIpAddress", () => {
    it("should hash a valid IP address using SHA-256", () => {
      const ipAddress = "203.0.113.195";
      const hash = hashIpAddress(ipAddress);

      // SHA-256 produces a 64-character hex string
      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it("should produce consistent hashes for the same IP", () => {
      const ipAddress = "198.51.100.42";
      const hash1 = hashIpAddress(ipAddress);
      const hash2 = hashIpAddress(ipAddress);

      expect(hash1).toBe(hash2);
    });

    it("should produce different hashes for different IPs", () => {
      const ip1 = "203.0.113.195";
      const ip2 = "198.51.100.42";

      const hash1 = hashIpAddress(ip1);
      const hash2 = hashIpAddress(ip2);

      expect(hash1).not.toBe(hash2);
    });

    it("should return undefined for undefined input", () => {
      const result = hashIpAddress(undefined);
      expect(result).toBeUndefined();
    });

    it("should hash IPv6 addresses", () => {
      const ipv6 = "2001:0db8:85a3:0000:0000:8a2e:0370:7334";
      const hash = hashIpAddress(ipv6);

      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it("should produce known hash for test IP (regression test)", () => {
      // This ensures the hashing algorithm remains consistent
      const ipAddress = "127.0.0.1";
      const expectedHash =
        "12ca17b49af2289436f303e0166030a21e525d266e209267433801a8fd4071a0";

      const hash = hashIpAddress(ipAddress);
      expect(hash).toBe(expectedHash);
    });

    it("should handle empty string by returning undefined", () => {
      const hash = hashIpAddress("");

      // Empty string is falsy, should return undefined
      expect(hash).toBeUndefined();
    });
  });
});
