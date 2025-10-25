# Twitter OAuth 1.0a Migration

## Summary
Migrates TwitterOAuthSession table from OAuth 2.0 to OAuth 1.0a structure.

## Changes
- Renames `state` → `oauthToken`
- Renames `codeVerifier` → `oauthTokenSecret`
- Updates indexes accordingly

## Reason
OAuth 2.0 follows endpoints require Enterprise tier ($42k/month). OAuth 1.0a friendships/show works with standard API access and provides the required following verification functionality.

## Prerequisites
⚠️ **IMPORTANT**: This migration must be coordinated with code deployment.

1. Ensure database backup exists
2. Backend code must be updated to use OAuth 1.0a (PR #123)
3. Frontend code must be updated (PR #320)
4. Environment variables must be updated:
   - `TWITTER_CLIENT_ID` → `TWITTER_CONSUMER_KEY`
   - `TWITTER_CLIENT_SECRET` → `TWITTER_CONSUMER_SECRET`
   - Add: `JUICESWAP_TWITTER_USERNAME=JuiceSwap_com`

## Applying Migration

```bash
# Apply migration
npx prisma migrate deploy

# Or for development
npx prisma migrate dev
```

## Rollback

If issues occur:

```bash
# Run rollback SQL
psql $DATABASE_URL -f prisma/migrations/20251025_twitter_oauth_1_0a_migration/rollback.sql

# Mark migration as rolled back
npx prisma migrate resolve --rolled-back 20251025_twitter_oauth_1_0a_migration
```

## Data Impact
- **Existing sessions will be invalidated** - Users will need to re-authenticate
- This is acceptable as sessions expire after 10 minutes anyway
- No data loss occurs

## Testing
After migration:
1. Test Twitter OAuth start endpoint
2. Test Twitter OAuth callback with valid credentials
3. Test following verification
4. Test error handling for non-followers

## Related PRs
- API: https://github.com/JuiceSwapxyz/api/pull/123
- Frontend: https://github.com/JuiceSwapxyz/bapp/pull/320
