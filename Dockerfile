# syntax=docker/dockerfile:1

# ── Stage 1: install dependencies (postinstall runs `prisma generate`) ──
FROM docker.io/library/node:22-alpine AS deps
WORKDIR /app
# prisma generate runs during `npm ci` and needs the schema + config.
COPY package.json package-lock.json prisma7.config.ts tsconfig.json ./
COPY prisma ./prisma
# Placeholder values: real connection details are injected at runtime via
# the compose environment. Only needed so module validation passes.
ENV DATABASE_URL="postgresql://provmon:provmon@postgres:5432/provmon" \
    REDIS_URL="redis://:build-time-placeholder@redis:6379" \
    AUTH_SECRET="build-time-placeholder-secret-not-used-at-runtime"
RUN npm ci

# ── Stage 2: build the Next.js app ──
FROM docker.io/library/node:22-alpine AS build
WORKDIR /app
ENV NODE_ENV="production" \
    DATABASE_URL="postgresql://provmon:provmon@postgres:5432/provmon" \
    REDIS_URL="redis://:build-time-placeholder@redis:6379" \
    AUTH_SECRET="build-time-placeholder-secret-not-used-at-runtime"
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN npm run build

# ── Stage 3: runtime ──
FROM docker.io/library/node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV="production"
# The full dependency tree is intentional: the web service runs
# `next start`, while the worker service runs the TypeScript entry point
# through tsx (a devDependency).
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.ts ./next.config.ts
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/prisma7.config.ts ./prisma7.config.ts
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/src ./src
COPY --from=build /app/public ./public
COPY --from=build /app/.next ./.next
RUN chown -R node:node /app
USER node
EXPOSE 3000
CMD ["npm", "run", "start"]
