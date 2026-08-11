# Stage 1: build the web panel (ui/) -> ../static
FROM node:24-slim AS web
WORKDIR /app/ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci
COPY ui/ ./
RUN npm run build

# Stage 2: Deno runtime.
# The image is source-only: server code + the baked panel live under /app.
# The deployment root (cwd) is /workspace — mount your host git repo there
# (config.yml + functions/). If no config.yml exists, the runtime generates
# a default one into /workspace on first boot.
FROM denoland/deno:2
WORKDIR /app
COPY deno.json deno.lock ./
COPY server ./server
COPY --from=web /app/static ./static
RUN deno cache --unstable-worker-options server/main.ts

WORKDIR /workspace
EXPOSE 18080 19090
CMD ["deno", "run", "--unstable-worker-options", "--allow-read=/app,/workspace", "--allow-write=.", "--allow-net", "--allow-env", "--allow-import", "--allow-ffi", "/app/server/main.ts"]
