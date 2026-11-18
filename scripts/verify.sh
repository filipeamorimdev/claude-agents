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
x claude-agents 'test -e /run/secrets || test -e /run/browser-secrets || test -e /vault || test -n "${BROWSER_SECRETS:-}"' && bad "browser logins are visible to the agents container" || ok "no browser logins in the agents container"
x claude-agents 'test -S /var/run/docker.sock' && bad "docker socket is mounted!" || ok "no docker socket"
# The logs are append-only: the database itself refuses changes and deletes (only your purge gets through, store.mjs)
x claude-agents 'node -e "const{DatabaseSync:D}=require(\"node:sqlite\");const n=new D(process.env.DATA_DIR+\"/agents.db\",{readOnly:true}).prepare(\"SELECT COUNT(*) n FROM sqlite_master WHERE type=\x27trigger\x27 AND name IN (\x27agent_log_no_update\x27,\x27agent_log_no_delete\x27,\x27events_no_update\x27,\x27events_no_delete\x27)\").get().n;process.exit(n===4?0:1)"' \
  && ok "logs are append-only (agents can't change or delete them)" || bad "the logs aren't protected against changes (update to the latest image)"
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
BRIDGE=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.Gateway}} {{end}}' claude-agents 2>/dev/null)  # this host, from inside (each of its networks)
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

echo "command sandbox (commands agents run after your OK)"
if [ "$(docker inspect -f '{{.State.Running}}' claude-agents-shell 2>/dev/null)" = true ]; then
  [ "$(docker inspect -f '{{.State.Health.Status}}' claude-agents-shell 2>/dev/null)" = healthy ] && ok "running and healthy" || bad "not healthy (docker logs claude-agents-shell)"
  [ "$(docker exec claude-agents-shell id -u)" != 0 ] && ok "runs as non-root" || bad "runs as root"
  [[ "$(docker inspect -f '{{.HostConfig.CapDrop}}' claude-agents-shell)" == *ALL* ]] && ok "all Linux capabilities dropped" || bad "capabilities not dropped"
  [ -z "$(docker port claude-agents-shell 2>/dev/null)" ] && ok "no ports published to the LAN" || bad "the sandbox has published ports"
  x claude-agents-shell 'touch /app/x || touch /etc/x' && bad "its root filesystem is writable" || ok "root filesystem is read-only"
  # Nothing of the app's is there: a command can't read or change the database, the logs, the config, the vault or the secrets
  x claude-agents-shell 'test -e /data || test -e /vault || test -e /run/browser-secrets || test -e /app/config || test -S /var/run/docker.sock || test -n "${UI_PASSWORD:-}${CLAUDE_CODE_OAUTH_TOKEN:-}${ANTHROPIC_API_KEY:-}${CODEX_API_KEY:-}${BROWSER_SECRETS:-}"' \
    && bad "the database, logs, vault or secrets are visible in the sandbox!" || ok "no database, logs, config, vault or secrets in it"
  mounts=$(docker inspect -f '{{range .Mounts}}{{.Destination}} {{end}}' claude-agents-shell | tr ' ' '\n' | sort | xargs)
  [ "$mounts" = "/run/control.pub /workspaces" ] && ok "mounts only the agents' workspace folders (and the app's public key)" || bad "unexpected mounts: $mounts"
  x claude-agents-shell 'test -e /data/home/control.key || find / -name control.key 2>/dev/null | grep -q .' && bad "the app's private control key is in the sandbox!" || ok "the app's private control key isn't there"
  x claude-agents 'node -e "fetch(\"http://shell:8933/health\",{signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"' \
    && ok "the app reaches it" || bad "the app cannot reach the sandbox"
  # From the app's container but unsigned, like an agent's own command there (Codex, Bash): refused
  r=$(docker exec claude-agents node -e 'fetch("http://shell:8933/exec",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({agent:"x",command:"id"})}).then(r=>console.log(r.status),()=>console.log("error"))' 2>/dev/null)
  [ "$r" = 403 ] && ok "runs only commands the app signed" || bad "the sandbox answered $r to an unsigned command"
  missing=$(docker exec claude-agents-shell sh -c 'for t in curl jq dig ping nc ssh lan lan-connect lan-ssh; do command -v $t >/dev/null || printf "%s " $t; done')
  [ -z "$missing" ] && ok "has curl, jq, dig, ping, nc, ssh, lan and lan-ssh" || bad "missing tools: $missing (update the image)"
  # A command calling back into the sandbox (or anything that isn't the app) must be refused
  r=$(docker exec claude-agents-shell node -e 'fetch("http://127.0.0.1:8933/exec",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({agent:"x",command:"id"})}).then(r=>console.log(r.status),()=>console.log("error"))' 2>/dev/null)
  [ "$r" = 403 ] && ok "refuses callers other than the app" || bad "the sandbox answered $r to a caller that isn't the app"
  # Its network has only the app: no vault, no browsers, no LAN, not this host
  for target in vault:8932 browser-admaster:8931 $(for h in $GW $LANIP $BRIDGE; do echo "$h:80"; done); do
    r=$(docker exec claude-agents-shell node -e '
      const [host,port]=process.argv[1].split(":");
      const s=require("net").connect({host,port:Number(port),timeout:3000});
      s.on("connect",()=>{console.log("open");process.exit()});
      s.on("timeout",()=>{console.log("blocked");process.exit()});
      s.on("error",e=>{console.log(e.code==="ECONNREFUSED"?"reachable":"blocked");process.exit()});' "$target" 2>/dev/null)
    [ "$r" = blocked ] && ok "${target%%:*} blocked from the sandbox" || bad "${target%%:*} is reachable from the sandbox"
  done
else
  bad "not running: agents can't run commands (docker logs claude-agents-shell)"
fi

echo "LAN gateway (the only way to devices you granted agents)"
if [ "$(docker inspect -f '{{.State.Running}}' claude-agents-lan 2>/dev/null)" = true ]; then
  [ "$(docker inspect -f '{{.State.Health.Status}}' claude-agents-lan 2>/dev/null)" = healthy ] && ok "running and healthy" || bad "not healthy (docker logs claude-agents-lan)"
  [ "$(docker exec claude-agents-lan id -u)" != 0 ] && ok "runs as non-root" || bad "runs as root"
  [[ "$(docker inspect -f '{{.HostConfig.CapDrop}}' claude-agents-lan)" == *ALL* ]] && ok "all Linux capabilities dropped" || bad "capabilities not dropped"
  [ -z "$(docker port claude-agents-lan 2>/dev/null)" ] && ok "no ports published to the LAN" || bad "the gateway has published ports"
  mounts=$(docker inspect -f '{{range .Mounts}}{{.Destination}} {{end}}' claude-agents-lan | tr ' ' '\n' | sort | xargs)
  [ "$mounts" = "/lan /run/control.pub /run/lan-logins" ] && ok "mounts only its own folder, the app's public key and the vault's device logins" || bad "unexpected mounts: $mounts"
  x claude-agents-lan 'test "$(stat -c %a /lan/lan.key)" = 600' && ok "its key is readable by its owner only" || bad "lan.key is missing or readable by others"
  # ssh refuses to start for a user id with no passwd entry; the gateway gives it one (nss_wrapper) when the image has none
  x claude-agents-lan 'getent passwd "$(id -u)" || test -f /usr/lib/*/libnss_wrapper.so' && ok "can run ssh for lan-ssh" || bad "ssh can't run as uid $(docker exec claude-agents-lan id -u) (update the image)"
  x claude-agents 'test -e /lan' || x claude-agents-shell 'test -e /lan' && bad "the device keys are visible outside the gateway!" || ok "device keys only in the gateway"
  r=$(docker exec claude-agents node -e 'fetch("http://lan:8934/_control/state").then(r=>console.log(r.status),()=>console.log("error"))' 2>/dev/null)
  [ "$r" = 403 ] && ok "takes orders only from the app (signed)" || bad "the gateway answered $r to an unsigned call"
  r2=$(docker exec claude-agents-shell node -e 'fetch("http://lan:8934/allow").then(r=>console.log(r.status),()=>console.log("error"))' 2>/dev/null)
  [ "$r2" = 403 ] && ok "only the firewall reads its list" || bad "the sandbox read the gateway's list ($r2)"
  allowed=$(docker exec claude-agents-firewall wget -q -T 3 -O - "http://$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' claude-agents-lan):8934/allow" 2>/dev/null | xargs)
  echo "  - devices granted to agents: ${allowed:-none}"
  for target in $GW $LANIP; do
    case " $allowed " in *" $target:80 "*) echo "  - $target:80 is granted, skipped"; continue ;; esac
    r=$(docker exec claude-agents-lan node -e '
      const s=require("net").connect({host:process.argv[1],port:80,timeout:3000});
      s.on("connect",()=>{console.log("open");process.exit()});
      s.on("timeout",()=>{console.log("blocked");process.exit()});
      s.on("error",e=>{console.log(e.code==="ECONNREFUSED"?"reachable":"blocked");process.exit()});' "$target" 2>/dev/null)
    [ "$r" = blocked ] && ok "LAN host $target blocked for the gateway too (not granted)" || bad "the gateway reaches $target:80, which nobody was granted"
  done
else
  bad "not running: agents can't reach any device you grant them (docker logs claude-agents-lan)"
fi

if docker inspect claude-agents-vault >/dev/null 2>&1; then
  echo "vault container (site logins)"
  [ "$(docker inspect -f '{{.State.Health.Status}}' claude-agents-vault 2>/dev/null)" = healthy ] && ok "running and healthy" || bad "not healthy (docker logs claude-agents-vault)"
  [ -z "$(docker port claude-agents-vault 2>/dev/null)" ] && ok "no ports published to the LAN" || bad "vault has published ports"
  x claude-agents-vault 'test "$(stat -c %a /vault/vault.key)" = 600' && ok "key readable by its owner only" || bad "vault.key is missing or readable by others"
  docker exec claude-agents node -e '
    fetch("http://vault:8932/logins",{signal:AbortSignal.timeout(5000)}).then(r=>r.text()).then(t=>{const j=JSON.parse(t);process.exit(j.logins.some(l=>"value" in l)?1:0)}).catch(()=>process.exit(2))'
  case $? in 0) ok "the app reaches it, and it answers with names only";; 1) bad "the vault returned a value!";; *) bad "the app cannot reach the vault";; esac
fi

if docker inspect browser-admaster >/dev/null 2>&1; then
  echo "browser-admaster container"
  [ "$(docker inspect -f '{{.State.Running}}' browser-admaster)" = true ] && ok "running" || bad "not running (docker logs browser-admaster)"
  n=$(docker exec browser-admaster sh -c 'ls /run/browser-secrets/agents 2>/dev/null | wc -l' 2>/dev/null | tr -d ' ')
  [ "${n:-0}" -gt 0 ] && ok "site logins from the vault for $n agent(s)" || echo "  - no site logins for any agent yet: add them in the chat (key icon)"
  docker exec browser-admaster test -e /run/browser-secrets/secrets.env && bad "every login is in one shared file" || ok "each agent's browser gets only its own logins"
  [ -z "$(docker port browser-admaster 2>/dev/null)" ] && ok "no ports published to the LAN" || bad "browser has published ports"
  docker exec claude-agents node -e '
    fetch("http://browser-admaster:8931/mcp",{signal:AbortSignal.timeout(5000)}).then(()=>process.exit(0)).catch(()=>process.exit(1))' \
    && ok "reachable from the agents container" || bad "agents cannot reach the browser"
  docker exec claude-agents node -e '
    Promise.all([8930,8940,8941].map(p=>fetch(`http://browser-admaster:${p}/mcp`,{signal:AbortSignal.timeout(3000)}).then(()=>1,()=>0)))
      .then(r=>process.exit(r.some(Boolean)?1:0))' \
    && ok "only reachable through its guard" || bad "an agent's browser is reachable without the guard"
  docker exec claude-agents node -e '
    fetch("http://browser-admaster:8931/mcp",{method:"POST",signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.status===400?0:1),()=>process.exit(1))' \
    && ok "refuses a caller that doesn't name its agent" || bad "the guard serves a caller without an agent name"
  docker exec claude-agents node --input-type=module -e '
    const u="http://browser-admaster:8931/mcp", h={"Content-Type":"application/json",Accept:"application/json, text/event-stream","X-Agent":"verify-check"};
    const rpc=async(body,sid)=>{const r=await fetch(u,{method:"POST",headers:sid?{...h,"mcp-session-id":sid}:h,body:JSON.stringify(body)});return {sid:r.headers.get("mcp-session-id"),text:await r.text()}};
    const {sid}=await rpc({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"verify",version:"1"}}});
    await rpc({jsonrpc:"2.0",method:"notifications/initialized"},sid);
    const {text}=await rpc({jsonrpc:"2.0",id:2,method:"tools/list"},sid);
    process.exit(text.includes("browser_navigate") && !/browser_run_code_unsafe|browser_evaluate/.test(text) ? 0 : 1)' \
    && ok "tools that could expose logins are off" || bad "the browser offers browser_run_code_unsafe or browser_evaluate"
fi

echo; echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
