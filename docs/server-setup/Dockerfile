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

# Install runtime deps as root so npm can write to /app, then chown
# everything to the non-root `node` user that the official node-alpine
# image ships with (uid 1000). Running Node as root makes any future
# RCE pop a root shell inside the container with full bind-mount write
# access; pivoting to `node` removes that blast radius without any
# functional trade-off (we don't need privileged ports).
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
RUN chown -R node:node /app

USER node

EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main"]

# In-container healthcheck — supplements the per-service healthcheck in
# docker-compose so a wedged Node process (event loop blocked,
# unresponsive on :3000) gets restart-by-orchestrator. `start-period`
# of 30s covers cold start; the api hits its /health endpoint, the
# worker uses a process-self-check (handled in the entrypoint).
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl --silent --fail http://127.0.0.1:3000/health || exit 1
