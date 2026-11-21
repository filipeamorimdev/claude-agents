#!/bin/sh
# One-shot setup run by the "init" service as root: creates the data folders with the right
# owners and copies the default config on first start. Safe to run on every start.
set -eu
T=/target
U=${AGENT_UID:-1000}
G=${AGENT_GID:-1000}

mkdir -p "$T/agents/workspaces/ad-master" "$T/agents/home" "$T/browsers/profiles" "$T/browsers/shots" "$T/vault" "$T/lan" "$T/config"
# Browsers are per agent now: the one shared profile becomes ad-master's (it had its sign-ins).
if [ -d "$T/browsers/admaster" ] && [ ! -e "$T/browsers/profiles/ad-master" ]; then
  mv "$T/browsers/admaster" "$T/browsers/profiles/ad-master"
  echo "moved the browser profile to browsers/profiles/ad-master"
fi

chown root:"$G" "$T"; chmod 750 "$T"
chown -R "$U:$G" "$T/agents" "$T/browsers" "$T/vault" "$T/lan"
chmod 750 "$T/agents"; chmod 700 "$T/agents/home" "$T/browsers" "$T/browsers/profiles" "$T/browsers/shots" "$T/vault" "$T/lan"

# Config is human-controlled: owned by root, readable (not writable) by the agents.
for f in agents mcp-servers; do
  if [ ! -f "$T/config/$f.mjs" ]; then
    cp "/app/defaults/$f.example.mjs" "$T/config/$f.mjs"
    echo "created config/$f.mjs from the defaults"
  fi
done
chown root:"$G" "$T/config"; chmod 755 "$T/config"
chmod 644 "$T/config"/*.mjs
# The app's control key (control.mjs): it signs every call to the command sandbox, the LAN gateway, the vault and the
# browser's live view, and makes each agent's browser token. The private half stays in the app's home (hidden from
# agents), the public half goes in config/ for the others.
node /app/control.mjs keygen "$T/agents/home/control.key" "$T/config/control.pub"
chown "$U:$G" "$T/agents/home/control.key"; chown root:"$G" "$T/config/control.pub"

# Optional https certificate for the chat (config/tls/cert.pem + key.pem): the key readable by the app's group only.
if [ -d "$T/config/tls" ]; then
  chown -R root:"$G" "$T/config/tls"; chmod 750 "$T/config/tls"
  find "$T/config/tls" -type f -exec chmod 640 {} +
fi

# The browser's guard and page rules (app/browser): app code, so replaced on every start, and read-only for the browser.
mkdir -p "$T/browsers/guard"
cp /app/browser/* "$T/browsers/guard/"
cp /app/control.mjs "$T/browsers/guard/"   # the guard checks the app's signatures and agent tokens with it
chown -R root:"$G" "$T/browsers/guard"; chmod 755 "$T/browsers/guard"; chmod 644 "$T/browsers/guard"/*

echo "data folder ready: agents → $U:$G"
