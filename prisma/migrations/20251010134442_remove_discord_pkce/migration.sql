-- AlterTable
-- Remove codeVerifier column from DiscordOAuthSession
-- Discord OAuth now uses standard Authorization Code Grant without PKCE
ALTER TABLE "DiscordOAuthSession" DROP COLUMN IF EXISTS "codeVerifier";
