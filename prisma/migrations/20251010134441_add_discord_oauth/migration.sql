-- AlterTable
ALTER TABLE "OgCampaignUser" ADD COLUMN     "discordUsername" TEXT;

-- CreateTable
CREATE TABLE "DiscordOAuthSession" (
    "id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "codeVerifier" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscordOAuthSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DiscordOAuthSession_state_key" ON "DiscordOAuthSession"("state");

-- CreateIndex
CREATE INDEX "DiscordOAuthSession_state_idx" ON "DiscordOAuthSession"("state");

-- CreateIndex
CREATE INDEX "DiscordOAuthSession_expiresAt_idx" ON "DiscordOAuthSession"("expiresAt");
