ARG NODE_VERSION=24.8.0

FROM node:${NODE_VERSION}-alpine

# Install OpenSSL (required by Prisma)
RUN apk add --no-cache openssl

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
