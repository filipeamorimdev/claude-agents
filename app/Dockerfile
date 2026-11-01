# Code and dependencies are baked into the image so the container can run read-only.
# config/ (agents seed + MCP server registry) is mounted read-only at runtime from DATA_DIR/config.
FROM node:22-bookworm-slim

ENV NODE_OPTIONS=--disable-warning=ExperimentalWarning
WORKDIR /app
COPY app/package.json ./
# The Codex CLI (OpenAI models) goes outside /app: its sandbox hides /app, and it re-runs its own binary inside it.
RUN npm install --omit=dev --no-audit --no-fund \
 && npm install -g --no-audit --no-fund "@openai/codex@$(node -p 'require("@openai/codex-sdk/package.json").version')" \
 && rm -rf node_modules/@openai/codex node_modules/@openai/codex-linux-* \
 && npm cache clean --force
COPY app/*.mjs app/init.sh ./
COPY app/ui ./ui
# Default config: copied to DATA_DIR/config by init.sh, and the fallback when a file is missing
COPY config/agents.example.mjs config/mcp-servers.example.mjs ./defaults/
RUN printf '#!/bin/sh\nexec node /app/cli.mjs "$@"\n' > /usr/local/bin/agents && chmod 755 /usr/local/bin/agents

EXPOSE 8090
CMD ["node", "runner.mjs"]
