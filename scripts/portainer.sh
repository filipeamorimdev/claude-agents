#!/usr/bin/env bash
# Portainer setup wizard. Run it on the Docker host that Portainer manages:
#
#   sudo bash scripts/portainer.sh
#
# It checks the host, creates the agents' system user, works out everything it can (uid/gid, timezone,
# a free port, free subnets, a chat password, which Portainer environment is this host), asks only for
# what it can't (your Claude token, a Portainer access token, and a GitHub token while the images are
# private), checks that the published images match this compose.yaml, then creates the stack through
# Portainer's API (or updates it, keeping what you set before), and runs the safeguard checks.
# Re-run it any time to change a setting or to update.
#
#   --env-only        don't talk to Portainer: write the variables to a file to load in the stack editor
#                     (Stacks → Add stack → Web editor → Load variables from .env file)
#   --dry-run         show what it would do, change nothing
#   --yes             take every default (unattended; secrets from the environment, use sudo -E):
#                       PORTAINER_API_KEY, CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY, GHCR_USER + GHCR_TOKEN
#   --url URL         Portainer's address (found automatically when Portainer runs on this host)
#   --name NAME       stack name (claude-agents)
#   --browser | --no-browser     the browser agent (asked otherwise)
#   --compose FILE    compose file to deploy (this repo's compose.yaml)
#   --out FILE        where --env-only writes the variables (./claude-agents.env)

set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
COMPOSE=$(cd "$HERE/.." && pwd)/compose.yaml
STACK=claude-agents
AGENT_USER=claude-agents
DEFAULT_IMAGE=ghcr.io/filipeamorimdev/claude-agents:latest
DEFAULT_FW_IMAGE=ghcr.io/filipeamorimdev/claude-agents-firewall:latest
YES=0 DRY=0 ENV_ONLY=0 OPT_BROWSER="" PURL=${PORTAINER_URL:-} OUT=./claude-agents.env

# ---------- helpers ----------
c_ok=$'\e[32m' c_warn=$'\e[33m' c_err=$'\e[31m' c_dim=$'\e[2m' c_b=$'\e[1m' c_off=$'\e[0m'
[ -t 1 ] || { c_ok="" c_warn="" c_err="" c_dim="" c_b="" c_off=""; }
step() { echo; echo "${c_ok}==>${c_off} ${c_b}$*${c_off}"; }
info() { echo "    $*"; }
warn() { echo "${c_warn}  ! $*${c_off}"; }
die()  { echo "${c_err}  ✗ $*${c_off}" >&2; exit 1; }
run()  { if [ "$DRY" = 1 ]; then echo "${c_dim}    [dry-run] $*${c_off}"; else "$@"; fi; }
tty_ok() { [ "$YES" = 0 ] && { true </dev/tty; } 2>/dev/null; }
ask() { # ask VAR "question" "default"   (reads the terminal, so it also works piped)
  local __v=$1 __q=$2 __d=${3:-} __a=""
  if tty_ok; then read -r -p "    $__q${__d:+ [$__d]}: " __a </dev/tty || true; fi
  printf -v "$__v" '%s' "${__a:-$__d}"
}
ask_secret() { # ask_secret VAR "question"   (hidden input; empty without a terminal)
  local __v=$1 __a=""
  if tty_ok; then read -r -s -p "    $2: " __a </dev/tty || true; echo; fi
  printf -v "$__v" '%s' "$__a"
}
yesno() { # yesno "question" y|n  -> 0 for yes
  local d=$2 a=""
  tty_ok || { [ "$d" = y ]; return; }
  read -r -p "    $1 [$( [ "$d" = y ] && echo Y/n || echo y/N )]: " a </dev/tty || true
  [[ "${a:-$d}" =~ ^[Yy] ]]
}
clean() { # refuse values the stack's env file can't carry as-is
  case "$2" in *'$'*|*$'\n'*|*'"'*|*"'"*) die "$1 can't contain \$, quotes or line breaks" ;; esac
}

# Settings: E_<NAME> variables, KEYS keeps their order (bash 3 compatible, so it runs on a Mac too)
KEYS=""
setv() { case " $KEYS " in *" $1 "*) ;; *) KEYS="$KEYS $1" ;; esac; printf -v "E_$1" '%s' "$2"; }
getv() { local n="E_$1"; printf '%s' "${!n:-}"; }
load_env() { # KEY=value lines on stdin
  local line
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    local v=${BASH_REMATCH[2]}
    v=${v#\'}; v=${v%\'}; v=${v#\"}; v=${v%\"}
    setv "${BASH_REMATCH[1]}" "$v"
  done
}
env_lines() { local k; for k in $KEYS; do printf '%s=%s\n' "$k" "$(getv "$k")"; done; }

# ---------- args ----------
while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y)     YES=1 ;;
    --dry-run)    DRY=1 ;;
    --env-only)   ENV_ONLY=1 ;;
    --browser)    OPT_BROWSER=1 ;;
    --no-browser) OPT_BROWSER=0 ;;
    --url)        PURL=${2:?}; shift ;;
    --name)       STACK=${2:?}; shift ;;
    --compose)    COMPOSE=${2:?}; shift ;;
    --out)        OUT=${2:?}; shift ;;
    -h|--help)    sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
  shift
done

TMPD=$(mktemp -d); chmod 700 "$TMPD"
trap 'rm -rf "$TMPD"' EXIT

# ---------- host ----------
step "Checking this host"
OS=$(uname -s)
if [ "$OS" != Linux ]; then
  [ "$DRY" = 1 ] || [ "$OS" = Darwin ] || die "run this on the Linux server Portainer manages"
  warn "not Linux ($OS): fine for a try-out on Docker Desktop, but the stack is meant for a Linux server"
fi
[ "$DRY" = 1 ] || [ "$OS" != Linux ] || [ "$(id -u)" = 0 ] || die "run as root: sudo bash $0"
[ -f "$COMPOSE" ] || die "compose file not found: $COMPOSE (run this from a checkout of the repo, or pass --compose)"
command -v docker >/dev/null || die "Docker is not installed"
docker info >/dev/null 2>&1 || die "can't reach Docker (is it running? are you root?)"
command -v curl >/dev/null || die "curl is missing (apt install curl)"
case "$(uname -m)" in
  x86_64|aarch64|arm64) info "architecture: $(uname -m) ✓" ;;
  armv7l|armv6l) die "32-bit ARM isn't supported: use a 64-bit OS" ;;
  *) warn "untested architecture: $(uname -m)" ;;
esac
if [ -r /proc/meminfo ]; then
  MEM_MB=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)
  [ "$MEM_MB" -lt 3500 ] && warn "only ${MEM_MB} MB RAM: 4 GB+ recommended (8 GB with the browser agent)"
fi
[ "$OS" = Linux ] && ! command -v iptables >/dev/null && ! [ -e /usr/sbin/iptables ] \
  && warn "iptables not found on the host: if the firewall container fails, set FIREWALL=off (agents could then reach your LAN)"
HAVE_PY=0; command -v python3 >/dev/null && HAVE_PY=1
if [ "$ENV_ONLY" = 0 ] && [ "$HAVE_PY" = 0 ]; then
  warn "python3 not found: it's needed to talk to Portainer's API, so only the variables file is written"
  ENV_ONLY=1
fi

# Containers with this stack's names that belong to something else (an install.sh install, another stack)
for cname in $(sed 's/#.*//' "$COMPOSE" | awk '$1=="container_name:"{print $2}' | tr -d '"'"'"); do
  proj=$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$cname" 2>/dev/null || true)
  if docker inspect "$cname" >/dev/null 2>&1 && [ "$proj" != "$STACK" ]; then
    die "a '$cname' container from another setup (${proj:-not compose}) exists. Remove it first (docker rm -f $cname), or for an install.sh install: sudo ./install.sh --uninstall"
  fi
done

# ---------- Portainer ----------
AUTH_H=$TMPD/auth
api() { # api METHOD PATH [BODY_FILE] -> response on stdout; non-zero on HTTP errors (message on stderr)
  local code
  code=$(curl -sS $CURL_K --max-time 900 -o "$TMPD/resp" -w '%{http_code}' -X "$1" -H @"$AUTH_H" \
    -H 'Content-Type: application/json' ${3:+--data-binary @"$3"} "$PURL/api$2") || { echo 000 >"$TMPD/code"; return 1; }
  echo "$code" >"$TMPD/code"
  if [ "$code" -ge 400 ]; then
    python3 -c 'import json,sys
raw=open(sys.argv[1]).read()
try:
  d=json.loads(raw); print(" ".join(str(d.get(k,"")) for k in ("message","details")).strip())
except Exception: print(raw[:300])' "$TMPD/resp" >&2
    return 1
  fi
  cat "$TMPD/resp"
}
api_code() { cat "$TMPD/code"; }

EID="" STACK_ID="" CURL_K=""
if [ "$ENV_ONLY" = 0 ]; then
  step "Connecting to Portainer"
  if [ -z "$PURL" ]; then
    pc=$(docker ps --format '{{.Names}} {{.Image}}' | awk '$2 ~ /portainer\/portainer-(ce|ee)/{print $1; exit}' || true)
    if [ -n "$pc" ]; then
      p=$(docker port "$pc" 9443/tcp 2>/dev/null | head -1 | awk -F: '{print $NF}' || true)
      if [ -n "$p" ]; then PURL=https://127.0.0.1:$p
      else p=$(docker port "$pc" 9000/tcp 2>/dev/null | head -1 | awk -F: '{print $NF}' || true); [ -n "$p" ] && PURL=http://127.0.0.1:$p; fi
      [ -n "$PURL" ] && info "found Portainer on this host ($pc)"
    fi
    ask PURL "Portainer address" "${PURL:-https://127.0.0.1:9443}"
  fi
  PURL=${PURL%/}
  # Portainer's own certificate is self-signed: accept it on this host, ask for anything else
  case "$PURL" in https://127.0.0.1*|https://localhost*|https://\[::1\]*) CURL_K=-k ;; esac
  if [ -z "$CURL_K" ] && [[ "$PURL" == https://* ]]; then
    curl -sS -o /dev/null --max-time 10 "$PURL/api/system/status" 2>/dev/null || {
      yesno "Portainer's certificate isn't trusted (its default self-signed one?). Connect anyway?" n || die "stopped"
      CURL_K=-k; }
  fi
  curl -sS $CURL_K -o /dev/null --max-time 10 "$PURL/api/system/status" || die "can't reach Portainer at $PURL (pass --url)"

  KEY=${PORTAINER_API_KEY:-}
  if [ -z "$KEY" ]; then
    info "A Portainer access token: in Portainer, your user (top right) → My account → Access tokens → Add."
    info "Or leave it empty to sign in with your Portainer username and password instead."
    ask_secret KEY "Access token"
  fi
  if [ -n "$KEY" ]; then
    (umask 077; printf 'X-API-Key: %s\n' "$KEY" >"$AUTH_H")
  else
    tty_ok || die "no PORTAINER_API_KEY"
    ask PUSER "Portainer username" admin; ask_secret PPASS "Portainer password"
    (umask 077; PUSER=$PUSER PPASS=$PPASS python3 -c 'import json,os;print(json.dumps({"username":os.environ["PUSER"],"password":os.environ["PPASS"]}))' >"$TMPD/login")
    : >"$AUTH_H"
    jwt=$(api POST /auth "$TMPD/login" | python3 -c 'import json,sys;print(json.load(sys.stdin)["jwt"])') || die "Portainer refused that sign-in"
    rm -f "$TMPD/login"; unset PPASS
    (umask 077; printf 'Authorization: Bearer %s\n' "$jwt" >"$AUTH_H")
  fi
  eps=$(api GET /endpoints) || die "Portainer refused the request (wrong token?)"
  info "signed in ✓"

  # Which Portainer environment is this host: same Docker engine ID, else the local socket one
  pick=$(printf '%s' "$eps" | python3 -c 'import json,sys
eps=[e for e in json.load(sys.stdin) if e.get("Type") in (1,2,4)  # Docker: local, agent, edge agent]
want=sys.argv[1]
def did(e):
  try: return e["Snapshots"][0]["DockerSnapshotRaw"]["Info"]["ID"]
  except Exception: return ""
m=[e for e in eps if want and did(e)==want] or [e for e in eps if str(e.get("URL","")).startswith("unix://")]
if len(m)==1: print("ID", m[0]["Id"], m[0]["Name"])
elif len(eps)==1: print("ID", eps[0]["Id"], eps[0]["Name"])
else:
  print("ASK")
  for e in eps: print(" ", e["Id"], e["Name"], e.get("URL",""))' "$(docker info -f '{{.ID}}' 2>/dev/null || true)")
  if [ "${pick%% *}" = ID ]; then
    EID=$(echo "$pick" | awk '{print $2}'); info "environment: $(echo "$pick" | cut -d' ' -f3-) (id $EID) ✓"
  else
    echo "$pick" | tail -n +2 | sed 's/^/    /'
    ask EID "Which environment is this host? (id)" ""
    [[ "$EID" =~ ^[0-9]+$ ]] || die "no environment picked"
  fi

  # An existing stack: update it and keep its settings
  found=$(api GET /stacks | python3 -c 'import json,sys
for s in json.load(sys.stdin):
  if s.get("Name")==sys.argv[1] and str(s.get("EndpointId"))==sys.argv[2]:
    print(s["Id"])
    for e in s.get("Env") or []: print("%s=%s" % (e["name"], e["value"]))
    break' "$STACK" "$EID") || die "couldn't list the stacks"
  if [ -n "$found" ]; then
    STACK_ID=$(echo "$found" | head -1)
    echo "$found" | tail -n +2 >"$TMPD/prev"
    load_env <"$TMPD/prev"
    info "stack '$STACK' exists (id $STACK_ID): updating it, keeping its settings"
  else
    info "stack '$STACK' will be created"
  fi
fi
[ -z "$STACK_ID" ] && [ -f "$OUT" ] && { load_env <"$OUT"; info "using the settings in $OUT as defaults"; }
FIRST=1; [ -n "$(getv UI_PASSWORD)" ] && FIRST=0

# ---------- system user ----------
step "System user for the agents' files"
if [ "$OS" != Linux ]; then
  UID_A=$(id -u) GID_A=$(id -g); info "not Linux: the files are yours ($UID_A:$GID_A)"
elif [ -e /usr/bin/midclt ]; then
  # TrueNAS: users made in its shell don't survive an update; its built-in apps user is meant for this
  UID_A=$(id -u apps 2>/dev/null || echo 568) GID_A=$(id -g apps 2>/dev/null || echo 568)
  info "TrueNAS: using its built-in apps user ($UID_A:$GID_A) ✓"
elif id "$AGENT_USER" >/dev/null 2>&1; then
  UID_A=$(id -u "$AGENT_USER") GID_A=$(id -g "$AGENT_USER"); info "$AGENT_USER exists ($UID_A:$GID_A) ✓"
else
  run useradd --system --user-group --no-create-home --shell /usr/sbin/nologin "$AGENT_USER"
  if [ "$DRY" = 1 ]; then UID_A=999 GID_A=999; else UID_A=$(id -u "$AGENT_USER") GID_A=$(id -g "$AGENT_USER"); fi
  info "created $AGENT_USER ($UID_A:$GID_A)"
fi
setv AGENT_UID "$UID_A"; setv AGENT_GID "$GID_A"

# ---------- settings ----------
step "Settings"
D=$(getv DATA_DIR)
if [ -z "$D" ]; then
  D=/opt/claude-agents-data
  omv=$(ls -d /srv/dev-disk-by-* 2>/dev/null | head -1 || true)
  [ -n "$omv" ] && D=$omv/claude-agents-data
  if [ -e /usr/bin/midclt ]; then   # TrueNAS: on the first pool (best: a dataset made with the Generic preset)
    pool=$(ls -d /mnt/*/ 2>/dev/null | head -1 || true)
    [ -n "$pool" ] && D=${pool%/}/claude-agents
  fi
fi
ask D "Data folder on this host (workspaces, logs, logins, config)" "$D"
case "$D" in /?*) ;; *) die "the data folder must be an absolute path (not /)" ;; esac
clean DATA_DIR "$D"; setv DATA_DIR "${D%/}"

T=$(getv TZ)
[ -z "$T" ] && T=$( (timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null \
  || readlink /etc/localtime 2>/dev/null | sed 's|.*zoneinfo/||' || echo UTC) | head -1)
ask T "Timezone for schedules" "${T:-UTC}"; clean TZ "$T"; setv TZ "$T"

# Credentials
OAUTH=${CLAUDE_CODE_OAUTH_TOKEN:-$(getv CLAUDE_CODE_OAUTH_TOKEN)}
APIKEY=${ANTHROPIC_API_KEY:-$(getv ANTHROPIC_API_KEY)}
[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && APIKEY=""
[ -n "${ANTHROPIC_API_KEY:-}" ] && OAUTH=""
CHATGPT=0; [ "$(getv AGENTS_SECCOMP)" = unconfined ] && CHATGPT=1
if [ -z "$OAUTH$APIKEY" ] || ! yesno "Keep the Claude credentials already set?" y; then
  info "Paste a token from \`claude setup-token\` (your Pro/Max plan) or an API key from console.anthropic.com."
  info "Empty = use only your ChatGPT plan. Input is hidden."
  ask_secret TOK "Claude token"
  case "$TOK" in
    sk-ant-oat*) OAUTH=$TOK APIKEY=""; info "subscription token ✓" ;;
    sk-ant-api*) APIKEY=$TOK OAUTH=""; info "API key ✓" ;;
    "") OAUTH="" APIKEY="" CHATGPT=1; info "no Claude token: agents use your ChatGPT plan" ;;
    *) die "that doesn't look like a Claude token (sk-ant-oat… or sk-ant-api…)" ;;
  esac
  clean token "$TOK"
fi
if [ -n "$OAUTH$APIKEY" ]; then
  yesno "Also use your ChatGPT plan (OpenAI models)?" "$( [ "$CHATGPT" = 1 ] && echo y || echo n )" && CHATGPT=1 || CHATGPT=0
fi
setv CLAUDE_CODE_OAUTH_TOKEN "$OAUTH"; setv ANTHROPIC_API_KEY "$APIKEY"
setv AGENTS_SECCOMP "$( [ "$CHATGPT" = 1 ] && echo unconfined || echo builtin )"
DM=$(getv DEFAULT_MODEL); [ -z "$DM" ] && { [ -z "$OAUTH$APIKEY" ] && DM=gpt-6.1-sol || DM=sonnet; }
setv DEFAULT_MODEL "$DM"

# Chat password: generated once, kept on re-runs
PW=$(getv UI_PASSWORD)
[ -z "$PW" ] && PW=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 20 || true)
setv UI_PASSWORD "$PW"

# Port: keep it, else the first free one from 8090
OURPORT=$(docker port claude-agents 8090/tcp 2>/dev/null | head -1 | awk -F: '{print $NF}' || true)
port_busy() {
  [ "$1" = "$OURPORT" ] && return 1   # ours (the conflict check above made sure of that)
  if command -v ss >/dev/null; then [ -n "$(ss -Htln "sport = :$1" 2>/dev/null)" ]
  elif command -v lsof >/dev/null; then lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  else return 1; fi
}
P=$(getv UI_PORT)
if [ -z "$P" ]; then P=8090; while port_busy "$P" && [ "$P" -lt 8190 ]; do P=$((P+1)); done; fi
port_busy "$P" && warn "port $P is in use by something else: the chat may not start (set UI_PORT)"
setv UI_PORT "$P"; [ -n "$(getv UI_BIND)" ] || setv UI_BIND 0.0.0.0
info "chat on port $P ✓"

# Subnets: keep them, else the first 172.X.0.0/16 block nothing on this host uses
if [ -z "$(getv AGENTS_SUBNET)" ]; then
  used=$( { for n in $(docker network ls -q); do
              docker network inspect -f '{{ index .Labels "com.docker.compose.project" }} {{range .IPAM.Config}}{{.Subnet}} {{end}}' "$n"
            done | awk -v s="$STACK" '$1!=s' ; ip -4 route 2>/dev/null || netstat -rn 2>/dev/null; } \
          | grep -oE '172\.[0-9]+\.' | sort -u | tr '\n' ' ' || true)
  X=""
  for x in 30 31 29 28 27 26 25 24 23 22 21 20; do case " $used " in *" 172.$x. "*) ;; *) X=$x; break ;; esac; done
  [ -n "$X" ] || die "no free 172.20-31.x.x block for the stack's networks: set AGENTS_SUBNET, SHELL_SUBNET, BROWSER_LAN_SUBNET by hand"
  setv AGENTS_SUBNET "172.$X.0.0/24"; setv SHELL_SUBNET "172.$X.1.0/24"; setv LAN_GATEWAY_IP "172.$X.1.250"
  setv BROWSER_LAN_SUBNET "172.$X.2.0/24"; setv LAN_GATEWAY_BROWSER_IP "172.$X.2.250"; setv LAN_BROWSER_IP "172.$X.2.10"
fi
info "networks: $(getv AGENTS_SUBNET) and the next two /24s ✓"
[ -n "$(getv FIREWALL)" ] || setv FIREWALL on

# Browser agent
B=0; [ "$(getv COMPOSE_PROFILES)" = browser ] && B=1
if [ -n "$OPT_BROWSER" ]; then B=$OPT_BROWSER
elif yesno "Enable the browser agent (signs in to websites, ~1 GB RAM)?" "$( [ "$B" = 1 ] && echo y || echo n )"; then B=1; else B=0; fi
setv COMPOSE_PROFILES "$( [ "$B" = 1 ] && echo browser )"
O=$(getv BROWSER_ALLOWED_ORIGINS); O=${O:-https://www.olx.pt}
[ "$B" = 1 ] && ask O "Websites the browser may open (separate with ;)" "$O"
clean BROWSER_ALLOWED_ORIGINS "$O"; setv BROWSER_ALLOWED_ORIGINS "$O"

# ---------- images ----------
step "Images"
IMG=$(getv AGENTS_IMAGE); IMG=${IMG:-$DEFAULT_IMAGE}
FW_IMG=$(getv FIREWALL_IMAGE); FW_IMG=${FW_IMG:-$DEFAULT_FW_IMAGE}
GHCR_NEEDED=0
pull() { # pull IMAGE, with no saved logins (a separate config), signing in to GHCR only if it's needed
  local cfg=$TMPD/docker; mkdir -p "$cfg"
  DOCKER_CONFIG=$cfg docker pull -q "$1" >/dev/null 2>"$TMPD/pullerr" && return 0
  case "$1" in ghcr.io/*) ;; *) cat "$TMPD/pullerr" >&2; return 1 ;; esac
  grep -qiE 'denied|unauthorized|not found|authentication' "$TMPD/pullerr" || { cat "$TMPD/pullerr" >&2; return 1; }
  if [ "$GHCR_NEEDED" = 0 ]; then
    GHCR_NEEDED=1
    info "The images on GHCR are private: a GitHub token with read:packages is needed"
    info "(github.com → Settings → Developer settings → Tokens (classic) → read:packages)."
    info "Or make both packages public on GitHub and re-run: then no token is needed."
    GU=${GHCR_USER:-}; [ -n "$GU" ] || ask GU "GitHub username" "$(echo "$1" | cut -d/ -f2)"
    GT=${GHCR_TOKEN:-}; [ -n "$GT" ] || ask_secret GT "GitHub token"
    [ -n "$GT" ] || die "no GitHub token"
    printf '%s' "$GT" | DOCKER_CONFIG=$cfg docker login ghcr.io -u "$GU" --password-stdin >/dev/null 2>&1 \
      || die "GHCR refused that token (it needs read:packages, and access to the repo)"
  fi
  DOCKER_CONFIG=$cfg docker pull -q "$1" >/dev/null
}
for i in "$IMG" "$FW_IMG"; do
  if [ "$DRY" = 1 ] && ! docker image inspect "$i" >/dev/null 2>&1; then info "[dry-run] would pull $i"; continue; fi
  pull "$i" || die "couldn't pull $i"
  info "$i ✓"
done
rm -rf "$TMPD/docker"

# The image must have every app file this compose.yaml runs (else it was built before your last changes)
files=$(sed 's/#.*//' "$COMPOSE" | grep -oE '/app/[A-Za-z0-9_./-]+\.(mjs|sh)' | sort -u | tr '\n' ' ' || true)
if [ -n "$files" ] && docker image inspect "$IMG" >/dev/null 2>&1; then
  missing=$(docker run --rm --network none --entrypoint sh "$IMG" -c 'for f; do [ -e "$f" ] || printf "%s " "$f"; done' sh $files)
  [ -z "$missing" ] || die "$IMG is older than $COMPOSE (it has no ${missing% }).
    Push your changes to main, wait for the 'images' workflow on GitHub to finish, then re-run this."
  created=$(docker image inspect -f '{{.Created}}' "$IMG" | cut -c1-16 | tr T ' ')
  info "image matches compose.yaml (built $created UTC) ✓"
fi

# ---------- write / deploy ----------
env_lines >"$TMPD/env"; chmod 600 "$TMPD/env"

if [ "$ENV_ONLY" = 1 ]; then
  step "Stack variables"
  if [ "$DRY" = 1 ]; then
    sed -E 's/^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|UI_PASSWORD|BROWSER_SECRETS|HA_TOKEN|CODEX_API_KEY)=.+/\1=<hidden>/; s/^/      /' "$TMPD/env"
  else
    (umask 077; { echo "# claude-agents stack variables ($(date '+%Y-%m-%d %H:%M')). Private: delete it once loaded."; cat "$TMPD/env"; } >"$OUT")
    info "written to $OUT (600)"
  fi
  cat <<EOF

    In Portainer: Stacks → Add stack → name it $STACK → Web editor: paste $COMPOSE
    → Environment variables → Load variables from .env file: pick $OUT → Deploy the stack.
EOF
  [ "$GHCR_NEEDED" = 1 ] && echo "    First add GHCR under Registries (Custom, ghcr.io, your GitHub username and token)."
  echo "    Then run: sudo bash $HERE/verify.sh"
  exit 0
fi

# Portainer pulls the images itself on updates: give it the GHCR login too
if [ "$GHCR_NEEDED" = 1 ]; then
  step "GHCR login in Portainer"
  (umask 077; GU=$GU GT=$GT python3 -c 'import json,os
print(json.dumps({"name":"GitHub Container Registry","type":3,"url":"ghcr.io","authentication":True,
  "username":os.environ["GU"],"password":os.environ["GT"]}))' >"$TMPD/reg")
  rid=$(api GET /registries | python3 -c 'import json,sys
for r in json.load(sys.stdin):
  if r.get("URL","").replace("https://","").rstrip("/")=="ghcr.io": print(r["Id"]); break') || die "couldn't list Portainer's registries"
  if [ "$DRY" = 1 ]; then info "[dry-run] would ${rid:+update}${rid:-add} the ghcr.io registry"
  elif [ -n "$rid" ]; then api PUT "/registries/$rid" "$TMPD/reg" >/dev/null || die "couldn't update the ghcr.io registry"; info "updated ✓"
  else api POST /registries "$TMPD/reg" >/dev/null || die "couldn't add the ghcr.io registry"; info "added ✓"; fi
  rm -f "$TMPD/reg"
fi

step "Data folder"
DATA=$(getv DATA_DIR)
run mkdir -p "$DATA"
# Run the stack's own init once now, so every file it bind-mounts exists before Portainer starts it
if [ "$DRY" = 1 ]; then info "[dry-run] would prepare $DATA (owner $UID_A:$GID_A)"
elif docker run --rm --network none --entrypoint test "$IMG" -f /app/init.sh 2>/dev/null; then
  docker run --rm --network none --user 0:0 --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
    --security-opt no-new-privileges:true -e AGENT_UID="$UID_A" -e AGENT_GID="$GID_A" \
    -v "$DATA:/target" --entrypoint /bin/sh "$IMG" /app/init.sh | sed 's/^/    /'
fi

step "$( [ -n "$STACK_ID" ] && echo "Updating" || echo "Creating" ) the stack in Portainer (pulls images, can take a few minutes)"
mode=$( [ -n "$STACK_ID" ] && echo update || echo create )
python3 -c 'import json,sys
mode,compose,envf,name=sys.argv[1:5]
env=[]
for line in open(envf):
  line=line.rstrip("\n")
  if line and not line.startswith("#"):
    k,v=line.split("=",1); env.append({"name":k,"value":v})
d={"stackFileContent":open(compose).read(),"env":env}
if mode=="create": d["name"]=name
else: d.update(prune=True,pullImage=True)
json.dump(d,sys.stdout)' "$mode" "$COMPOSE" "$TMPD/env" "$STACK" >"$TMPD/body"
if [ "$DRY" = 1 ]; then
  info "[dry-run] would $mode stack '$STACK' on environment $EID with:"
  sed -E 's/^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|UI_PASSWORD|BROWSER_SECRETS|HA_TOKEN|CODEX_API_KEY)=.+/\1=<hidden>/; s/^/      /' "$TMPD/env"
  exit 0
fi
if [ "$mode" = update ]; then
  api PUT "/stacks/$STACK_ID?endpointId=$EID" "$TMPD/body" >/dev/null || die "Portainer couldn't update the stack (see above, and the stack's page in Portainer)"
else
  out=$(api POST "/stacks/create/standalone/string?endpointId=$EID" "$TMPD/body") || {
    # Portainer before 2.19
    case "$(api_code)" in 404|405) out=$(api POST "/stacks?type=2&method=string&endpointId=$EID" "$TMPD/body") ;; *) false ;; esac
  } || die "Portainer couldn't create the stack (see above, and Stacks in Portainer)"
  STACK_ID=$(printf '%s' "$out" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("Id",""))' 2>/dev/null || true)
fi
rm -f "$TMPD/body"
info "deployed ✓"

# ---------- after ----------
step "Starting"
for _ in $(seq 1 60); do
  [ "$(docker inspect -f '{{.State.Running}}' claude-agents 2>/dev/null)" = true ] \
    && docker exec claude-agents agents list >/dev/null 2>&1 && break
  sleep 3
done
if [ "$(docker inspect -f '{{.State.Running}}' claude-agents 2>/dev/null)" != true ]; then
  warn "claude-agents isn't running yet: see its logs in Portainer (or docker logs claude-agents)"
else
  info "claude-agents is up ✓"
  if [ "$B" = 1 ] && [ "$FIRST" = 1 ]; then
    docker exec claude-agents agents enable ad-master >/dev/null 2>&1 && info "browser agent ad-master enabled ✓"
  fi
fi

if [ -f "$HERE/verify.sh" ]; then
  step "Checking the safeguards"
  bash "$HERE/verify.sh" || warn "some checks failed, see above"
fi

if [ "$CHATGPT" = 1 ] && ! docker exec claude-agents sh -c 'test -f "${CODEX_HOME:-$HOME/.codex}/auth.json"' 2>/dev/null; then
  step "ChatGPT sign-in"
  if tty_ok && yesno "Sign in to your ChatGPT plan now?" y; then
    docker exec -it claude-agents codex login --device-auth </dev/tty || warn "not signed in: run docker exec -it claude-agents codex login --device-auth"
  else
    info "later: docker exec -it claude-agents codex login --device-auth"
  fi
fi

step "Done"
IP=$( (ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}') || true)
[ -z "$IP" ] && IP=$(ipconfig getifaddr en0 2>/dev/null || hostname)
SCHEME=http; [ -f "$DATA/config/tls/cert.pem" ] && SCHEME=https
echo "    Chat:      $SCHEME://$IP:$(getv UI_PORT)"
if [ "$FIRST" = 1 ]; then echo "    Password:  $(getv UI_PASSWORD)   (also in the stack's variables in Portainer: UI_PASSWORD)"
else echo "    Password:  unchanged (UI_PASSWORD in the stack's variables)"; fi
[ -n "$STACK_ID" ] && echo "    Portainer: $PURL/#!/$EID/docker/stacks/$STACK?id=$STACK_ID&type=2"
cat <<EOF
    Config:    $DATA/config/   (then restart claude-agents)
    To change a setting or update: edit the stack's variables in Portainer and redeploy, or re-run this.
EOF
[ "$SCHEME" = http ] && echo "    For phone notifications, put cert.pem + key.pem in $DATA/config/tls/ and re-run (https)."
exit 0
