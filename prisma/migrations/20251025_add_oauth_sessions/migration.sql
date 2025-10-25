-- AlterTable
ALTER TABLE "OgCampaignUser" ADD COLUMN IF NOT EXISTS "twitterUsername" TEXT;
ALTER TABLE "OgCampaignUser" ADD COLUMN IF NOT EXISTS "discordUsername" TEXT;

-- CreateTable TwitterOAuthSession (OAuth 1.0a)
CREATE TABLE IF NOT EXISTS "TwitterOAuthSession" (
    "id" TEXT NOT NULL,
    "oauthToken" TEXT NOT NULL,
    "oauthTokenSecret" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TwitterOAuthSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable DiscordOAuthSession
CREATE TABLE IF NOT EXISTS "DiscordOAuthSession" (
    "id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscordOAuthSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "TwitterOAuthSession_oauthToken_key" ON "TwitterOAuthSession"("oauthToken");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TwitterOAuthSession_oauthToken_idx" ON "TwitterOAuthSession"("oauthToken");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TwitterOAuthSession_expiresAt_idx" ON "TwitterOAuthSession"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "DiscordOAuthSession_state_key" ON "DiscordOAuthSession"("state");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DiscordOAuthSession_state_idx" ON "DiscordOAuthSession"("state");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DiscordOAuthSession_expiresAt_idx" ON "DiscordOAuthSession"("expiresAt");

