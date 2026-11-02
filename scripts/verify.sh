#!/usr/bin/env bash
# Checks that the safeguards are actually in place. Safe to run any time:
#   sudo bash scripts/verify.sh
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

pass=0 fail=0
ok()  { echo "  ✓ $*"; pass=$((pass+1)); }
bad() { echo "  ✗ $*"; fail=$((fail+1)); }
x()   { docker exec "$1" sh -c "$2" >/dev/null 2>&1; }

echo "claude-agents container"
if [ "$(docker inspect -f '{{.State.Running}}' claude-agents 2>/dev/null)" != true ]; then
  bad "not running (docker logs claude-agents)"; echo; echo "$pass passed, $fail failed"; exit 1
fi
ok "running"
[ "$(docker exec claude-agents id -u)" != 0 ] && ok "runs as non-root (uid $(docker exec claude-agents id -u))" || bad "runs as root"
x claude-agents 'touch /app/x' && bad "/app is writable" || ok "app code is read-only"
x claude-agents 'touch /etc/x' && bad "root filesystem is writable" || ok "root filesystem is read-only"
x claude-agents 'touch /data/.w && rm /data/.w' && ok "data folder is writable" || bad "cannot write to /data (check ownership of DATA_DIR/agents)"
x claude-agents 'test -e /run/secrets || test -n "${BROWSER_SECRETS:-}"' && bad "browser logins are visible to the agents container" || ok "no browser logins in the agents container"
x claude-agents 'test -S /var/run/docker.sock' && bad "docker socket is mounted!" || ok "no docker socket"
caps=$(docker inspect -f '{{.HostConfig.CapDrop}}' claude-agents)
[[ "$caps" == *ALL* ]] && ok "all Linux capabilities dropped" || bad "capabilities not dropped ($caps)"
claude=0 chatgpt=0
x claude-agents 'test -n "$CLAUDE_CODE_OAUTH_TOKEN$ANTHROPIC_API_KEY"' && claude=1 && ok "Claude credentials present"
x claude-agents 'test -n "${CODEX_API_KEY:-}" || test -f "${CODEX_HOME:-$HOME/.codex}/auth.json"' && chatgpt=1 && ok "signed in with ChatGPT (OpenAI models)"
[ "$claude$chatgpt" = 00 ] && bad "no credentials (set CLAUDE_CODE_OAUTH_TOKEN, or: docker exec -it claude-agents codex login --device-auth)"
if [[ "$(docker inspect -f "{{json .HostConfig.SecurityOpt}}" claude-agents)" == *seccomp=unconfined* ]] || [ "$chatgpt" = 1 ]; then
  # A sandboxed command must not see the logins, logs or database (same rules codex.mjs applies)
  probe='cd /data && codex sandbox -c "permissions={ \"p\" = { \"extends\" = \":read-only\", \"filesystem\" = { \"/data/home\" = \"deny\", \"/app\" = \"deny\" } } }" -P p -C /data --'
  if x claude-agents "$probe true"; then
    x claude-agents "$probe ls /data/home" && bad "Codex sandbox doesn't hide private files" || ok "Codex sandbox works and hides private files"
  else
    bad "Codex sandbox can't start (set AGENTS_SECCOMP=unconfined; on Ubuntu 23.10+ hosts see the README)"
  fi
fi
x claude-agents 'agents list' && ok "agent database readable ($(docker exec claude-agents sh -c 'agents list | tail -n +2 | grep -c .') agents)" || bad "agents CLI / database not working"

echo "chat UI"
UI_PORT=$(docker port claude-agents 8090/tcp 2>/dev/null | head -1 | awk -F: '{print $NF}'); UI_PORT=${UI_PORT:-8090}
UI=http; curl -sk -o /dev/null "https://127.0.0.1:$UI_PORT/" 2>/dev/null && UI=https   # config/tls certificate
code=$(curl -sk -o /dev/null -w '%{http_code}' "$UI://127.0.0.1:$UI_PORT/" 2>/dev/null)
[ "$code" = 200 ] && ok "UI answers on port $UI_PORT ($UI)" || bad "UI not reachable on port $UI_PORT (got $code; is UI_PASSWORD set?)"
code=$(curl -sk -o /dev/null -w '%{http_code}' "$UI://127.0.0.1:$UI_PORT/api/state" 2>/dev/null)
[ "$code" = 401 ] && ok "UI requires the password" || bad "UI API answered $code without a password!"

echo "firewall container"
if [ "$(docker inspect -f '{{.State.Running}}' claude-agents-firewall 2>/dev/null)" = true ]; then
  [ "$(docker inspect -f '{{.State.Health.Status}}' claude-agents-firewall)" = healthy ] && ok "running and healthy" || bad "not healthy (docker logs claude-agents-firewall)"
  docker logs claude-agents-firewall 2>&1 | grep -q "FIREWALL=off" && bad "FIREWALL=off: the agents can reach your LAN"
else
  bad "not running (docker logs claude-agents-firewall)"
fi

echo "network"
docker exec claude-agents node -e '
fetch("https://api.anthropic.com",{signal:AbortSignal.timeout(8000)}).then(()=>process.exit(0)).catch(()=>process.exit(1))' \
  && ok "internet reachable (api.anthropic.com)" || bad "cannot reach api.anthropic.com"

GW=$(ip route 2>/dev/null | awk '/^default/{print $3; exit}')                                   # your router
LANIP=$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')  # this host
if [ -z "$GW$LANIP" ] && command -v route >/dev/null && [ "$(uname)" = Darwin ]; then          # macOS (Docker Desktop)
  GW=$(route -n get default 2>/dev/null | awk '/gateway:/{print $2}')
  LANIP=$(ipconfig getifaddr "$(route -n get default 2>/dev/null | awk '/interface:/{print $2}')" 2>/dev/null)
fi
BRIDGE=$(docker network inspect -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}' "$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}' claude-agents)" 2>/dev/null)  # this host, from inside
for target in $GW $LANIP $BRIDGE; do
  # DROP -> timeout (blocked). Refused/connected -> the packet got through (not blocked).
  r=$(docker exec claude-agents node -e '
    const s=require("net").connect({host:process.argv[1],port:80,timeout:3000});
    s.on("connect",()=>{console.log("open");process.exit()});
    s.on("timeout",()=>{console.log("blocked");process.exit()});
    s.on("error",e=>{console.log(e.code==="ECONNREFUSED"?"reachable":"blocked");process.exit()});' "$target" 2>/dev/null)
  [ "$r" = blocked ] && ok "LAN host $target blocked" || bad "LAN host $target is reachable from the agents (firewall inactive?)"
done
[ -z "$GW$LANIP" ] && echo "  - could not detect LAN addresses, skipped"

if docker inspect browser-admaster >/dev/null 2>&1; then
  echo "browser-admaster container"
  [ "$(docker inspect -f '{{.State.Running}}' browser-admaster)" = true ] && ok "running" || bad "not running (docker logs browser-admaster)"
  x browser-admaster 'test -s /run/browser-secrets/secrets.env' && ok "site logins loaded (BROWSER_SECRETS)" || bad "no site logins: BROWSER_SECRETS is empty"
  [ -z "$(docker port browser-admaster 2>/dev/null)" ] && ok "no ports published to the LAN" || bad "browser has published ports"
  docker exec claude-agents node -e '
    fetch("http://browser-admaster:8931/mcp",{signal:AbortSignal.timeout(5000)}).then(()=>process.exit(0)).catch(()=>process.exit(1))' \
    && ok "reachable from the agents container" || bad "agents cannot reach the browser"
fi

echo; echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
