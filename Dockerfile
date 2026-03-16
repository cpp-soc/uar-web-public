# syntax=docker/dockerfile:1.6
# Multi-stage Dockerfile for Next.js application
FROM node:20-alpine AS base

RUN apk add --no-cache libc6-compat
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS deps

# Copy package files
COPY my-app/package.json my-app/package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm npm ci

FROM base AS builder
WORKDIR /app

# Reuse dependencies from the cached deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy Prisma config and schema separately for better layer caching
COPY my-app/prisma.config.ts ./prisma.config.ts
COPY my-app/prisma ./prisma
RUN npx prisma generate

# Copy the rest of the application source after Prisma generation
COPY my-app/ .

# Define build arguments for public variables with defaults for build
ARG NEXT_PUBLIC_APP_URL="http://localhost:3002"
ARG NEXT_PUBLIC_TURNSTILE_SITE_KEY="1x00000000000000000000AA"

# Set environment variables for build time (Next.js inlines NEXT_PUBLIC_ vars)
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_TURNSTILE_SITE_KEY=$NEXT_PUBLIC_TURNSTILE_SITE_KEY

# Set dummy environment variables to satisfy build-time validation
# These are NOT persisted to the final image, only used for 'npm run build'
# Set dummy environment variables to satisfy build-time validation
# These are NOT persisted to the final image, only used for 'npm run build'
ARG DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy?sslmode=require"
ARG SMTP_HOST="dummy"
ARG SMTP_PORT="587"
ARG SMTP_USER="dummy"
ARG SMTP_PASSWORD="dummy"
ARG EMAIL_FROM="dummy"
ARG ADMIN_EMAIL="dummy"
ARG LDAP_URL="ldaps://dummy"
ARG LDAP_BIND_DN="dummy"
ARG LDAP_BIND_PASSWORD="dummy"
ARG LDAP_SEARCH_BASE="dummy"
ARG LDAP_DOMAIN="dummy"
ARG LDAP_ADMIN_GROUPS="dummy"
ARG LDAP_GROUP2ADD="dummy"
ARG NEXTAUTH_SECRET="dummy_secret_at_least_32_chars_long_12345"
ARG ENCRYPTION_SECRET="dummy_secret_at_least_32_chars_long_12345"
ARG ENCRYPTION_SALT="dummy_salt_at_least_32_chars_long_12345"
ARG TURNSTILE_SECRET_KEY="dummy"

# Make ARGs available as ENV vars during build only
ENV DATABASE_URL=$DATABASE_URL \
    SMTP_HOST=$SMTP_HOST \
    SMTP_PORT=$SMTP_PORT \
    SMTP_USER=$SMTP_USER \
    SMTP_PASSWORD=$SMTP_PASSWORD \
    EMAIL_FROM=$EMAIL_FROM \
    ADMIN_EMAIL=$ADMIN_EMAIL \
    LDAP_URL=$LDAP_URL \
    LDAP_BIND_DN=$LDAP_BIND_DN \
    LDAP_BIND_PASSWORD=$LDAP_BIND_PASSWORD \
    LDAP_SEARCH_BASE=$LDAP_SEARCH_BASE \
    LDAP_DOMAIN=$LDAP_DOMAIN \
    LDAP_ADMIN_GROUPS=$LDAP_ADMIN_GROUPS \
    LDAP_GROUP2ADD=$LDAP_GROUP2ADD \
    NEXTAUTH_SECRET=$NEXTAUTH_SECRET \
    ENCRYPTION_SECRET=$ENCRYPTION_SECRET \
    ENCRYPTION_SALT=$ENCRYPTION_SALT \
    TURNSTILE_SECRET_KEY=$TURNSTILE_SECRET_KEY 

# Build Next.js application
RUN npm run build

FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production

# Runtime environment variables for Turnstile (will be overridden by docker-compose)
ENV TURNSTILE_SECRET_KEY=""
ENV NEXT_PUBLIC_TURNSTILE_SITE_KEY=""

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copy necessary files
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

# Ensure proper permissions for public directory
RUN chown -R nextjs:nodejs /app/public && \
    chmod -R 755 /app/public

USER nextjs

EXPOSE 3002

ENV PORT=3002
ENV HOSTNAME="0.0.0.0"

# Start the application
CMD ["node", "server.js"]
