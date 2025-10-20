-- AlterTable
-- Add ipAddressHash column to User table for privacy-preserving IP tracking
-- Stores SHA-256 hash of IP addresses instead of plain text for GDPR compliance
ALTER TABLE "User" ADD COLUMN "ipAddressHash" TEXT;
