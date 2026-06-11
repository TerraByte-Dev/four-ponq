# Multi-stage Dockerfile for a Vite (or webpack / esbuild / etc.) SPA.
# Builds the static bundle, then serves it from a tiny nginx-alpine image.
# Final image ~25 MB. Listens on port 3000.

# ---------- Stage 1: build ----------
FROM node:20-alpine AS build
WORKDIR /app

# Dependency install — cached unless package.json changes
COPY package*.json ./
RUN npm ci

# Build the static bundle
COPY . .
RUN npm run build

# ---------- Stage 2: serve ----------
FROM nginx:alpine

# Replace the default nginx config so it listens on 3000 (arcade convention)
RUN { \
      echo 'server {'; \
      echo '  listen 3000;'; \
      echo '  server_name _;'; \
      echo '  root /usr/share/nginx/html;'; \
      echo '  index index.html;'; \
      echo '  include /etc/nginx/mime.types;'; \
      echo '  default_type application/octet-stream;'; \
      echo '  location / {'; \
      echo '    try_files $uri $uri/ /index.html;'; \
      echo '  }'; \
      echo '}'; \
    } > /etc/nginx/conf.d/default.conf

COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 3000
CMD ["nginx", "-g", "daemon off;"]
