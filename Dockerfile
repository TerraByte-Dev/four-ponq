# Multi-stage Dockerfile for four-ponq (Stage 1 networked multiplayer).
#
# Shape: node-ws (NOT the old vite-static/nginx shape).
#   build   — node:20-alpine: npm ci, then `npm run build` produces BOTH the
#             client SPA bundle (dist/) AND the compiled CommonJS server
#             (dist-server/, with a {"type":"commonjs"} marker so Node runs the
#             CJS output even though the package is "type":"module").
#   deps    — node:20-alpine: production-only node_modules (npm ci --omit=dev),
#             so the runtime image carries `ws` but not vite/typescript/etc.
#   runtime — node:20-alpine (NOT nginx): runs `node` on the compiled server.
#
# The server listens on 0.0.0.0:3000, serves the static client bundle from
# ./dist for all non-/ws routes, and handles the WebSocket upgrade at /ws.
#
# Cache-Control parity with the old nginx config is the SERVER's job (set in
# the node static handler): index.html -> "no-cache" (always revalidate so
# menu/overlay updates land immediately); hashed /assets/* ->
# "public, max-age=31536000, immutable". This Dockerfile just ships the bundle.

# ---------- Stage 1: build (client bundle + compiled server) ----------
FROM node:20-alpine AS build
WORKDIR /app

# Install ALL deps (incl. vite/typescript) — cached unless package*.json change.
COPY package*.json ./
RUN npm ci

# Build both targets: `npm run build` = build:client (tsc && vite build -> dist/)
# then build:server (tsc -p tsconfig.server.json -> dist-server/ + CJS marker).
COPY . .
RUN npm run build

# ---------- Stage 2: production deps only ----------
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# ---------- Stage 3: runtime (node, NOT nginx) ----------
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Production node_modules (carries `ws`; no build toolchain).
COPY --from=deps   /app/node_modules ./node_modules
# Compiled CommonJS server (+ its dist-server/package.json CJS marker).
COPY --from=build  /app/dist-server  ./dist-server
# Static client bundle the server serves for all non-/ws routes.
COPY --from=build  /app/dist         ./dist
# Manifest (for `npm start` resolution and metadata).
COPY package.json ./

EXPOSE 3000
CMD ["node", "dist-server/server/index.js"]
