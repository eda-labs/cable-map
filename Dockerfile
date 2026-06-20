# One package, one image, one process: build the Vite bundle + compile the TS server,
# then run it. Serves the UI + /api + /pdf. Single container in the EDA cluster.

# 1. build: vite -> dist/, tsc -> dist-server/ (needs devDependencies)
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# 2. runtime: plain Node on the compiled JS + system Chromium for Puppeteer
FROM node:22-slim
ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=1 \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium ca-certificates fonts-liberation \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev                   # express + puppeteer only
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
EXPOSE 8080
CMD ["node", "dist-server/server.js"]
