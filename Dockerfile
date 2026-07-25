# syntax=docker/dockerfile:1.7
# Multi-stage build: install + compile in the builder stage, then ship only the
# runtime artifacts (dist + production node_modules) in a slim release image.
FROM node:22.12-alpine AS builder

# The .dockerignore controls what enters the build context. We only COPY the
# files the `prepare` build needs: package.json, package-lock.json,
# tsconfig.json, and src/.
WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
COPY src ./src

# `npm install` triggers `prepare` -> `npm run build` (tsc + shx chmod +x dist/*.js).
RUN --mount=type=cache,target=/root/.npm npm install

# Produce a production-only dependency tree to copy into the release stage.
RUN --mount=type=cache,target=/root/.npm-production \
    npm ci --ignore-scripts --omit-dev

# ---- Runtime stage -------------------------------------------------------
FROM node:22-alpine AS release

ENV NODE_ENV=production
# Container defaults for the Streamable HTTP entry point.
ENV MCP_HTTP_HOST=0.0.0.0
ENV MCP_HTTP_PORT=4500

WORKDIR /app

# Copy package manifest, lockfile, and the prebuilt dist tree. The +x bits
# applied by `shx chmod +x dist/*.js` in the builder are preserved by COPY.
# CALENDAR_TOKEN is intentionally NOT set here -- it must be supplied at runtime.
COPY --from=builder --chown=node:node /app/package.json /app/package.json
COPY --from=builder --chown=node:node /app/package-lock.json /app/package-lock.json
COPY --from=builder --chown=node:node /app/dist /app/dist

# Install only production deps in the slim runtime image.
RUN npm ci --ignore-scripts --omit-dev

EXPOSE 4500

# Run as the unprivileged `node` user shipped with the base image. Port 4500
# is a high port and requires no elevated capability.
USER node

# Start the Streamable HTTP entry point at /mcp.
ENTRYPOINT ["node", "dist/http.js"]