# Multi-stage build for ARM64. Used by the bootstrap deploy (compose builds
# this from /opt/bondzi/app). After the first GHCR image lands, the
# production docker-compose.yml pulls from GHCR and this Dockerfile is no
# longer touched on the box.
#
# IMPORTANT: build target is linux/arm64 (Lightsail ARM). If you ever
# build this on an x86 laptop, use:
#   docker buildx build --platform=linux/arm64 ...

FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
# Keep the Node heap below ~512 MB so the worker container can't run away
# on a 2 GB box. Tune up only if you scale instance size.
ENV NODE_OPTIONS=--max-old-space-size=512
# tini reaps zombies and forwards SIGTERM cleanly so BullMQ jobs drain.
# curl is for the container healthcheck against /health.
RUN apk add --no-cache tini curl
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main"]
