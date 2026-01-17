# Stage 1: Dependencies
FROM node:20-alpine AS builder

# Set working directory
WORKDIR /app

# Copy package files
COPY scraper/package*.json ./

# Copy Prisma schema (needed for prisma generate)
COPY scraper/prisma ./prisma

# Install dependencies
RUN npm ci --only=production

# Generate Prisma client
RUN npx prisma generate

# Stage 2: Production
FROM node:20-alpine AS production

# Install runtime dependencies
# - dumb-init: proper signal handling
# - openssl: required by Prisma
RUN apk add --no-cache \
    dumb-init \
    openssl \
    openssl-dev

# Set working directory
WORKDIR /app

# Copy node_modules and generated Prisma client from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/generated ./generated

# Copy scraper source code (excluding node_modules and prisma schema)
COPY scraper/config ./config
COPY scraper/cores ./cores
COPY scraper/middlewares ./middlewares
COPY scraper/routes ./routes
COPY scraper/scrapers ./scrapers
COPY scraper/scripts ./scripts
COPY scraper/services ./services
COPY scraper/index.js ./index.js
COPY scraper/package*.json ./

# Copy prisma schema (for reference, client already generated)
COPY scraper/prisma ./prisma

# Set ownership to node user (already exists in node:alpine)
RUN chown -R node:node /app

# Switch to non-root user
USER node

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Default command (override in compose if needed)
CMD ["node", "index.js"]