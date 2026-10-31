#!/bin/sh
# One-shot setup run by the "init" service as root: creates the data folders with the right
# owners and copies the default config on first start. Safe to run on every start.
set -eu
T=/target
U=${AGENT_UID:-1000}
G=${AGENT_GID:-1000}

mkdir -p "$T/agents/workspaces/ad-master/shots" "$T/browsers/admaster" "$T/config"

chown root:"$G" "$T"; chmod 750 "$T"
chown -R "$U:$G" "$T/agents" "$T/browsers"
chmod 750 "$T/agents"; chmod 700 "$T/browsers" "$T/browsers/admaster"

# Config is human-controlled: owned by root, readable (not writable) by the agents.
for f in agents mcp-servers; do
  if [ ! -f "$T/config/$f.mjs" ]; then
    cp "/app/defaults/$f.example.mjs" "$T/config/$f.mjs"
    echo "created config/$f.mjs from the defaults"
  fi
done
chown root:"$G" "$T/config"; chmod 755 "$T/config"
chmod 644 "$T/config"/*.mjs

echo "data folder ready: agents → $U:$G"
