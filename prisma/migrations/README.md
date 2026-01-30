# Prisma Migrations

## Running Migrations

### Development

```bash
# Apply pending migrations
npx prisma migrate dev

# Create a new migration
npx prisma migrate dev --name your_migration_name
```

### Production

```bash
# Apply migrations
npx prisma migrate deploy

# Check migration status
npx prisma migrate status
```

### Reset Database (Development Only)

```bash
# WARNING: This will delete all data
npx prisma migrate reset
```

## Migration Files

- `20241006_init_og_campaign/` - Initial OG Campaign database schema
  - Creates `User` table for wallet addresses
  - Creates `OgCampaignUser` table for campaign progress
  - Includes social verification tracking (Twitter, Discord)
