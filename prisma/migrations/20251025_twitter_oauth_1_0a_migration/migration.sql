-- Migration: Twitter OAuth 2.0 -> OAuth 1.0a
-- Changes TwitterOAuthSession table structure for OAuth 1.0a authentication

-- Drop existing indexes on old column names
DROP INDEX "TwitterOAuthSession_state_key";
DROP INDEX "TwitterOAuthSession_state_idx";

-- Rename columns
ALTER TABLE "TwitterOAuthSession" RENAME COLUMN "state" TO "oauthToken";
ALTER TABLE "TwitterOAuthSession" RENAME COLUMN "codeVerifier" TO "oauthTokenSecret";

-- Create indexes on new column names
CREATE UNIQUE INDEX "TwitterOAuthSession_oauthToken_key" ON "TwitterOAuthSession"("oauthToken");
CREATE INDEX "TwitterOAuthSession_oauthToken_idx" ON "TwitterOAuthSession"("oauthToken");
