# Code and dependencies are baked into the image so the container can run read-only.
# config/ (agents seed + MCP server registry) is mounted read-only at runtime.
FROM node:22-bookworm-slim

ENV NODE_OPTIONS=--disable-warning=ExperimentalWarning
WORKDIR /app
COPY app/package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY app/*.mjs ./
COPY app/ui ./ui
# Fallback config so the image runs even without the mounted config/ folder
COPY config/agents.example.mjs config/mcp-servers.example.mjs ./config/
RUN printf '#!/bin/sh\nexec node /app/cli.mjs "$@"\n' > /usr/local/bin/agents && chmod 755 /usr/local/bin/agents

EXPOSE 8090
CMD ["node", "runner.mjs"]
