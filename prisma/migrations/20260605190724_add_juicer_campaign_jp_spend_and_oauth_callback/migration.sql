-- AlterTable
ALTER TABLE "DiscordOAuthSession" ADD COLUMN     "callbackUrl" TEXT;

-- CreateTable
CREATE TABLE "JuicerCampaignUser" (
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "twitterVerifiedAt" TIMESTAMP(3),
    "twitterUserId" TEXT,
    "twitterUsername" TEXT,
    "discordVerifiedAt" TIMESTAMP(3),
    "discordUserId" TEXT,
    "discordUsername" TEXT,

    CONSTRAINT "JuicerCampaignUser_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "JpSpend" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "walletAddress" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,

    CONSTRAINT "JpSpend_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JuicerCampaignUser_twitterUserId_idx" ON "JuicerCampaignUser"("twitterUserId");

-- CreateIndex
CREATE INDEX "JuicerCampaignUser_discordUserId_idx" ON "JuicerCampaignUser"("discordUserId");

-- CreateIndex
CREATE INDEX "JpSpend_walletAddress_idx" ON "JpSpend"("walletAddress");

-- CreateIndex
CREATE UNIQUE INDEX "JpSpend_walletAddress_chainId_reason_key" ON "JpSpend"("walletAddress", "chainId", "reason");

-- AddForeignKey
ALTER TABLE "JuicerCampaignUser" ADD CONSTRAINT "JuicerCampaignUser_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
