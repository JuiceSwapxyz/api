#!/bin/sh
set -e

echo "JuiceSwap API - Starting..."
echo ""

# Run database migrations
echo "Running database migrations..."
if ! npx prisma migrate deploy; then
  echo "ERROR: Migration failed"
  exit 1
fi

echo "✓ Migrations complete"
echo ""
echo "Starting application..."
echo ""

# Start the application
# Using exec replaces the shell process with node for proper signal handling
exec "$@"
