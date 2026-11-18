# Code and dependencies are baked into the image so the container can run read-only.
# config/ (agents seed + MCP server registry) is mounted read-only at runtime from DATA_DIR/config.
FROM node:22-bookworm-slim

ENV NODE_OPTIONS=--disable-warning=ExperimentalWarning
# Tools for the commands agents run in the command sandbox (same image): look at a service, a name, a port, a host.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl jq dnsutils iputils-ping netcat-openbsd openssh-client libnss-wrapper \
 && cp /bin/ping /bin/ping.new && mv /bin/ping.new /bin/ping \
 && rm -rf /var/lib/apt/lists/*
# ↑ ping without its file capability (the containers have none): it uses unprivileged ICMP (ping_group_range in compose.yaml)
WORKDIR /app
COPY app/package.json ./
# The Codex CLI (OpenAI models) goes outside /app: its sandbox hides /app, and it re-runs its own binary inside it.
# Its version is the SDK's own (read by path: the SDK's exports hide package.json, and an empty version means "latest").
RUN npm install --omit=dev --no-audit --no-fund \
 && v=$(node -p 'require("./node_modules/@openai/codex-sdk/package.json").version') && test -n "$v" \
 && npm install -g --no-audit --no-fund "@openai/codex@$v" \
 && rm -rf node_modules/@openai/codex node_modules/@openai/codex-linux-* \
 && npm cache clean --force
COPY app/*.mjs app/init.sh ./
COPY app/ui ./ui
# Run inside the browser container (init.sh copies them to DATA_DIR/browsers/guard)
COPY app/browser ./browser
# Default config: copied to DATA_DIR/config by init.sh, and the fallback when a file is missing
COPY config/agents.example.mjs config/mcp-servers.example.mjs ./defaults/
RUN printf '#!/bin/sh\nexec node /app/cli.mjs "$@"\n' > /usr/local/bin/agents && chmod 755 /usr/local/bin/agents
# `lan <command>`, `lan-connect` and `lan-ssh`: a command's way to the devices its agent was granted (through the LAN gateway, lan.mjs)
COPY app/bin/lan /usr/local/bin/lan
COPY app/bin/lan-connect.mjs /usr/local/bin/lan-connect
COPY app/bin/lan-ssh.mjs /usr/local/bin/lan-ssh
# ssh's password prompt in the gateway, for `lan-ssh --login` (prints what the gateway gives that one ssh, nothing anywhere else)
COPY app/bin/lan-askpass /usr/local/bin/lan-askpass
RUN chmod 755 /usr/local/bin/lan /usr/local/bin/lan-connect /usr/local/bin/lan-ssh /usr/local/bin/lan-askpass

EXPOSE 8090
CMD ["node", "runner.mjs"]
