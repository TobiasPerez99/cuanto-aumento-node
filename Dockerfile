ARG NODE_VERSION=24.8.0

FROM node:${NODE_VERSION}-alpine

# Install OpenSSL (required by Prisma) + Chromium (required by the Santander
# promos scraper: its WAF only answers to a real browser TLS fingerprint, so
# scrapers/promos/santander.js drives puppeteer-core against this binary).
RUN apk add --no-cache openssl chromium nss freetype harfbuzz ca-certificates ttf-freefont

# puppeteer-core never downloads a browser; point it at the system Chromium.
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./
COPY prisma ./prisma/

# Install ALL dependencies (including devDependencies for Prisma)
RUN npm ci

# Copy source code
COPY . .

# Expose port
EXPOSE 3001

# Start command (generate Prisma client and start server)
CMD ["sh", "-c", "npx prisma generate && npm start"]
