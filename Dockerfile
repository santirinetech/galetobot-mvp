# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY apps/web/ apps/web/
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS api
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules/ node_modules/
COPY apps/api/package.json apps/api/
COPY apps/api/src/ apps/api/src/
COPY scripts/deploy/ scripts/deploy/
USER node
CMD ["node", "apps/api/src/index.js", "--hosted"]

FROM api AS whatsapp
USER root
RUN apt-get update && apt-get install -y --no-install-recommends util-linux \
    && rm -rf /var/lib/apt/lists/*
USER node

FROM nginx:stable-alpine AS web
RUN rm /etc/nginx/conf.d/default.conf
COPY deploy/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/apps/web/dist/ /usr/share/nginx/html/
