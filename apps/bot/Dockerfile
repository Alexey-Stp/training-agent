FROM node:20-alpine AS base

# Install dependencies only when needed
FROM base AS deps
WORKDIR /app

# Copy workspace configuration
COPY package*.json ./
COPY tsconfig.base.json ./
COPY prisma ./prisma

# Copy package files
COPY packages/core/package*.json ./packages/core/
COPY apps/bot/package*.json ./apps/bot/

# Install dependencies
RUN npm ci

# Build stage
FROM base AS builder
WORKDIR /app

# Copy dependencies
COPY --from=deps /app/node_modules ./node_modules

# Copy source code
COPY package*.json ./
COPY tsconfig.base.json ./
COPY prisma ./prisma
COPY packages/core ./packages/core
COPY apps/bot ./apps/bot

# Generate Prisma client
RUN npx prisma generate

# Build packages
WORKDIR /app/packages/core
RUN npm run build

# Build bot
WORKDIR /app/apps/bot
RUN npm run build

# Production stage
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production

# Copy necessary files
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/core/package.json ./packages/core/
COPY --from=builder /app/apps/bot/dist ./apps/bot/dist
COPY --from=builder /app/apps/bot/package.json ./apps/bot/
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./

# Run as non-root user
USER node

WORKDIR /app/apps/bot

CMD ["node", "dist/index.js"]
