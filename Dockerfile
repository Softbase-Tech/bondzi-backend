# syntax=docker/dockerfile:1.7
# =============================================================================
# PassMaster Backend — production image
# =============================================================================

FROM node:20-alpine AS builder
WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package.json yarn.lock* package-lock.json* ./
RUN if [ -f yarn.lock ]; then yarn install --frozen-lockfile; \
    elif [ -f package-lock.json ]; then npm ci; \
    else npm install; fi

COPY tsconfig*.json nest-cli.json ormconfig.ts ./
COPY src ./src

RUN npm run build


FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

RUN addgroup -S passmaster && adduser -S passmaster -G passmaster

COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/ormconfig.ts ./ormconfig.ts
COPY --from=builder /app/tsconfig.json ./tsconfig.json

RUN chown -R passmaster:passmaster /app
USER passmaster

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "dist/src/main.js"]
