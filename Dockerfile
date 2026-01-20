# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Copy Prisma schema (needed for postinstall)
COPY prisma ./prisma

# Install dependencies (postinstall will run prisma generate)
RUN npm ci

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Runtime stage
FROM node:20-alpine

WORKDIR /app

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Copy package files
COPY package*.json ./

# Copy Prisma schema (needed for postinstall prisma generate)
COPY --from=builder /app/prisma ./prisma

# Install production dependencies (includes prisma for migrations)
# postinstall will run: prisma generate
RUN npm ci --omit=dev && \
    npm cache clean --force

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist

# Copy generated Prisma client (defensive backup - build script should handle this)
COPY --from=builder /app/src/generated ./dist/generated

# Copy entrypoint script for automated migrations
COPY entrypoint.sh /app/entrypoint.sh

# Make entrypoint executable and change ownership to nodejs user
RUN chmod +x /app/entrypoint.sh && \
    chown -R nodejs:nodejs /app

# Switch to non-root user
USER nodejs

# Expose port
EXPOSE 3000

# Health check (start-period accounts for migration time)
HEALTHCHECK --interval=30s --timeout=3s --start-period=60s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/healthz', (r) => r.statusCode === 200 ? process.exit(0) : process.exit(1))"

# Use dumb-init and entrypoint script for signal handling and migrations
ENTRYPOINT ["dumb-init", "--", "/app/entrypoint.sh"]

# Application start command (passed to entrypoint.sh)
CMD ["node", "dist/server.js"]