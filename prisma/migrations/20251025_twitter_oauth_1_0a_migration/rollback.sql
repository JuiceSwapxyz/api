-- Rollback Migration: OAuth 1.0a -> OAuth 2.0
-- Reverts TwitterOAuthSession table structure back to OAuth 2.0

-- Drop OAuth 1.0a indexes
DROP INDEX "TwitterOAuthSession_oauthToken_key";
DROP INDEX "TwitterOAuthSession_oauthToken_idx";

-- Rename columns back
ALTER TABLE "TwitterOAuthSession" RENAME COLUMN "oauthToken" TO "state";
ALTER TABLE "TwitterOAuthSession" RENAME COLUMN "oauthTokenSecret" TO "codeVerifier";

-- Recreate OAuth 2.0 indexes
CREATE UNIQUE INDEX "TwitterOAuthSession_state_key" ON "TwitterOAuthSession"("state");
CREATE INDEX "TwitterOAuthSession_state_idx" ON "TwitterOAuthSession"("state");
