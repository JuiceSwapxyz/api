-- AlterTable
ALTER TABLE "OgCampaignUser" ADD COLUMN "twitterUsername" TEXT;

-- CreateTable
CREATE TABLE "TwitterOAuthSession" (
    "id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "codeVerifier" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TwitterOAuthSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TwitterOAuthSession_state_key" ON "TwitterOAuthSession"("state");

-- CreateIndex
CREATE INDEX "TwitterOAuthSession_state_idx" ON "TwitterOAuthSession"("state");

-- CreateIndex
CREATE INDEX "TwitterOAuthSession_expiresAt_idx" ON "TwitterOAuthSession"("expiresAt");
