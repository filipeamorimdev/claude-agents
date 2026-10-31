#!/usr/bin/env bash
# claude-agents installer
#
#   sudo ./install.sh                      interactive install (or re-run to update)
#   sudo ./install.sh --browser            also enable the browser agent container
#   sudo ./install.sh --yes                non-interactive; token read from env:
#        CLAUDE_CODE_OAUTH_TOKEN=... sudo -E ./install.sh --yes --data-dir /srv/x/agents
#   sudo ./install.sh --uninstall          stop and remove services (keeps data)
#   sudo ./install.sh --uninstall --purge  also delete data, secrets, config and the system user
#   ./install.sh --dry-run                 print what would be done, change nothing
#
# Other options: --data-dir DIR  --tz ZONE  --subnet CIDR  --ui-port N  --no-firewall  --no-browser

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_DIR"

AGENT_USER=claude-agents
FW_BIN=/usr/local/sbin/claude-agents-firewall
FW_UNIT=/etc/systemd/system/claude-agents-firewall.service
ETC_DIR=/etc/claude-agents

YES=0 DRY=0 UNINSTALL=0 PURGE=0 FIREWALL=1
OPT_DATA_DIR="" OPT_TZ="" OPT_SUBNET="" OPT_BROWSER="" OPT_UI_PORT=""

# ---------- helpers ----------
c_ok=$'\e[32m' c_warn=$'\e[33m' c_err=$'\e[31m' c_dim=$'\e[2m' c_off=$'\e[0m'
[ -t 1 ] || { c_ok="" c_warn="" c_err="" c_dim="" c_off=""; }
step() { echo; echo "${c_ok}==>${c_off} $*"; }
info() { echo "    $*"; }
warn() { echo "${c_warn}  ! $*${c_off}"; }
die()  { echo "${c_err}  ✗ $*${c_off}" >&2; exit 1; }
run()  { if [ "$DRY" = 1 ]; then echo "${c_dim}    [dry-run] $*${c_off}"; else "$@"; fi; }
ask() { # ask VAR "question" "default"
  local __var=$1 __q=$2 __def=${3:-} __ans
  if [ "$YES" = 1 ]; then printf -v "$__var" '%s' "$__def"; return; fi
  read -r -p "    $__q${__def:+ [$__def]}: " __ans || true
  printf -v "$__var" '%s' "${__ans:-$__def}"
}
yesno() { # yesno "question" default(y/n) -> returns 0 for yes
  local def=$2 ans
  if [ "$YES" = 1 ]; then [ "$def" = y ]; return; fi
  read -r -p "    $1 [$( [ "$def" = y ] && echo Y/n || echo y/N )]: " ans || true
  ans=${ans:-$def}; [[ "$ans" =~ ^[Yy] ]]
}
env_get() { [ -f .env ] && grep -E "^$1=" .env | tail -1 | cut -d= -f2- || true; }

# ---------- args ----------
while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y)      YES=1 ;;
    --dry-run)     DRY=1 ;;
    --uninstall)   UNINSTALL=1 ;;
    --purge)       PURGE=1 ;;
    --no-firewall) FIREWALL=0 ;;
    --browser)     OPT_BROWSER=1 ;;
    --no-browser)  OPT_BROWSER=0 ;;
    --data-dir)    OPT_DATA_DIR=${2:?}; shift ;;
    --tz)          OPT_TZ=${2:?}; shift ;;
    --subnet)      OPT_SUBNET=${2:?}; shift ;;
    --ui-port)     OPT_UI_PORT=${2:?}; shift ;;
    -h|--help)     sed -n '2,15p' "$0"; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
  shift
done

[ "$DRY" = 1 ] || [ "$(id -u)" = 0 ] || die "run as root: sudo ./install.sh"

# ---------- uninstall ----------
if [ "$UNINSTALL" = 1 ]; then
  if [ "$PURGE" = 1 ]; then
    DATA_DIR=$(env_get DATA_DIR)
    warn "--purge deletes ${DATA_DIR:-<unknown data dir>} (agent workspaces, logs, browser logins), .env, secrets and config/agents.mjs."
    [ "$YES" = 1 ] || yesno "Really purge everything?" n || die "aborted, nothing changed"
  fi
  step "Stopping containers"
  run docker compose --profile browser down || true
  step "Removing firewall service"
  if [ -f "$FW_UNIT" ]; then
    run systemctl disable --now claude-agents-firewall || true
    run rm -f "$FW_UNIT"; run systemctl daemon-reload
  elif [ -x "$FW_BIN" ]; then
    run "$FW_BIN" --remove "$(env_get AGENTS_SUBNET)" || true
  fi
  run rm -f "$FW_BIN"
  if [ "$PURGE" = 1 ]; then
    step "Purging data"
    [ -n "$DATA_DIR" ] && [ "$DATA_DIR" != "/" ] && run rm -rf "$DATA_DIR"
    run rm -rf "$ETC_DIR" .env config/agents.mjs config/mcp-servers.mjs
    run find secrets -name '*.env' ! -name '*.example' -delete
    id "$AGENT_USER" >/dev/null 2>&1 && run userdel "$AGENT_USER" || true
    run docker image rm claude-agents:local || true
  else
    info "Data, .env, secrets and config kept. Use --uninstall --purge to delete them."
  fi
  step "Uninstalled"
  exit 0
fi

# ---------- checks ----------
step "Checking system"
ARCH=$(uname -m)
case "$ARCH" in
  x86_64|aarch64|arm64) info "architecture: $ARCH ✓" ;;
  armv7l|armv6l) die "32-bit ARM is not supported. Use a 64-bit OS (e.g. Raspberry Pi OS 64-bit)." ;;
  *) warn "untested architecture: $ARCH" ;;
esac
command -v docker >/dev/null || die "Docker is not installed (https://docs.docker.com/engine/install/)"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 plugin is missing ('docker compose')"
info "docker: $(docker --version | cut -d, -f1) ✓"
info "compose: $(docker compose version --short) ✓"
MEM_MB=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)
[ "$MEM_MB" -lt 3500 ] && warn "only ${MEM_MB} MB RAM; 4 GB+ recommended (8 GB with the browser agent)"
[ -d /etc/openmediavault ] && info "OpenMediaVault detected"
for cname in claude-agents browser-admaster; do
  owner=$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' "$cname" 2>/dev/null || true)
  if [ -n "$owner" ] && [ "$owner" != "$REPO_DIR" ]; then
    die "a '$cname' container from another setup is running ($owner). Stop it first (OMV: Services → Compose → Files → Down)."
  fi
done

# ---------- settings ----------
step "Settings"

# Data directory (suggest a data disk on OMV, keep the previous value on re-runs)
DEF_DATA=$(env_get DATA_DIR)
if [ -z "$DEF_DATA" ]; then
  DEF_DATA=/opt/claude-agents-data
  OMV_DISK=$(ls -d /srv/dev-disk-by-* 2>/dev/null | head -1 || true)
  [ -n "$OMV_DISK" ] && DEF_DATA="$OMV_DISK/claude-agents-data"
fi
if [ -n "$OPT_DATA_DIR" ]; then DATA_DIR=$OPT_DATA_DIR; else ask DATA_DIR "Data folder (workspaces, logs, browser logins)" "$DEF_DATA"; fi
case "$DATA_DIR" in /*) ;; *) die "data folder must be an absolute path" ;; esac
[ "$DATA_DIR" = / ] && die "refusing to use / as data folder"

# Timezone
DEF_TZ=$(env_get TZ)
[ -z "$DEF_TZ" ] && DEF_TZ=$( (timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo UTC) | head -1)
if [ -n "$OPT_TZ" ]; then TZ_VAL=$OPT_TZ; else ask TZ_VAL "Timezone for schedules" "$DEF_TZ"; fi

# Subnet
DEF_SUBNET=$(env_get AGENTS_SUBNET); DEF_SUBNET=${DEF_SUBNET:-172.30.0.0/24}
SUBNET=${OPT_SUBNET:-$DEF_SUBNET}
for net_id in $(docker network ls -q 2>/dev/null); do
  net_name=$(docker network inspect -f '{{.Name}}' "$net_id" 2>/dev/null || true)
  case "$net_name" in *_agents) continue ;; esac
  if docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}} {{end}}' "$net_id" 2>/dev/null | grep -qw "$SUBNET"; then
    die "subnet $SUBNET is already used by Docker network '$net_name'; re-run with --subnet 172.31.0.0/24"
  fi
done
info "agents network: $SUBNET ✓"

# Auth token
TOKEN_OAUTH=$(env_get CLAUDE_CODE_OAUTH_TOKEN); TOKEN_API=$(env_get ANTHROPIC_API_KEY)
[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && TOKEN_OAUTH=$CLAUDE_CODE_OAUTH_TOKEN TOKEN_API=""
[ -n "${ANTHROPIC_API_KEY:-}" ] && TOKEN_API=$ANTHROPIC_API_KEY TOKEN_OAUTH=""
if [ -z "$TOKEN_OAUTH$TOKEN_API" ] || { [ "$YES" = 0 ] && ! yesno "Keep the existing Claude credentials?" y; }; then
  [ "$YES" = 1 ] && die "no credentials: export CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY and use sudo -E"
  info "Paste a token from \`claude setup-token\` (uses your Pro/Max plan)"
  info "or an API key from console.anthropic.com (billed per token). Input is hidden."
  read -r -s -p "    Token: " T; echo
  case "$T" in
    sk-ant-oat*) TOKEN_OAUTH=$T TOKEN_API="" ; info "subscription token ✓" ;;
    sk-ant-api*) TOKEN_API=$T TOKEN_OAUTH="" ; info "API key ✓" ;;
    *) die "that doesn't look like a Claude token (expected sk-ant-oat… or sk-ant-api…)" ;;
  esac
fi

# Chat UI
UI_PORT=${OPT_UI_PORT:-$(env_get UI_PORT)}; UI_PORT=${UI_PORT:-8090}
UI_PASSWORD=$(env_get UI_PASSWORD)
UI_NEW_PASSWORD=0
if [ -z "$UI_PASSWORD" ]; then
  UI_PASSWORD=$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20)
  UI_NEW_PASSWORD=1
fi
info "chat UI on port $UI_PORT"

# Browser agent
DEF_PROFILES=$(env_get COMPOSE_PROFILES)
if [ "$OPT_BROWSER" = 1 ]; then BROWSER=1
elif [ "$OPT_BROWSER" = 0 ]; then BROWSER=0
elif [ "$DEF_PROFILES" = browser ]; then BROWSER=1
elif yesno "Enable the browser agent container (logs into websites, ~0.5-1 GB RAM)?" n; then BROWSER=1
else BROWSER=0; fi
ORIGINS=$(env_get BROWSER_ALLOWED_ORIGINS); ORIGINS=${ORIGINS:-https://www.olx.pt}
if [ "$BROWSER" = 1 ] && [ "$YES" = 0 ]; then
  ask ORIGINS "Websites the browser may open (separate with ;)" "$ORIGINS"
fi

# ---------- system user ----------
step "System user"
if id "$AGENT_USER" >/dev/null 2>&1; then
  info "$AGENT_USER exists ✓"
else
  run useradd --system --user-group --no-create-home --shell /usr/sbin/nologin "$AGENT_USER"
  info "created $AGENT_USER"
fi
if [ "$DRY" = 1 ] && ! id "$AGENT_USER" >/dev/null 2>&1; then UID_A=999 GID_A=999
else UID_A=$(id -u "$AGENT_USER"); GID_A=$(id -g "$AGENT_USER"); fi
info "uid:gid = $UID_A:$GID_A"

# ---------- folders ----------
step "Folders in $DATA_DIR"
run mkdir -p "$DATA_DIR/agents/workspaces/ad-master/shots" "$DATA_DIR/browsers/admaster"
run chown root:"$GID_A" "$DATA_DIR"; run chmod 750 "$DATA_DIR"
run chown -R "$UID_A:$GID_A" "$DATA_DIR/agents" "$DATA_DIR/browsers"
run chmod 750 "$DATA_DIR/agents"; run chmod 700 "$DATA_DIR/browsers" "$DATA_DIR/browsers/admaster"
info "agents → $DATA_DIR/agents   browser profiles → $DATA_DIR/browsers (700)"

# ---------- config, secrets, .env ----------
step "Config and secrets"
for f in agents mcp-servers; do
  if [ -f "config/$f.mjs" ]; then info "config/$f.mjs exists, keeping it ✓"
  else run cp "config/$f.example.mjs" "config/$f.mjs"; info "created config/$f.mjs from the example"; fi
  run chmod 644 "config/$f.mjs"
done

run chmod 700 secrets
if [ -f secrets/admaster.env ]; then info "secrets/admaster.env exists, keeping it ✓"
else run cp secrets/admaster.env.example secrets/admaster.env; info "created secrets/admaster.env (fill in your logins)"; fi
run chown "$UID_A:$GID_A" secrets/admaster.env; run chmod 400 secrets/admaster.env

ENV_CONTENT="# Generated by install.sh on $(date -Iseconds). Private: chmod 600.
CLAUDE_CODE_OAUTH_TOKEN=$TOKEN_OAUTH
ANTHROPIC_API_KEY=$TOKEN_API
UI_PASSWORD=$UI_PASSWORD
UI_PORT=$UI_PORT
UI_BIND=$(env_get UI_BIND | grep . || echo 0.0.0.0)
AGENT_UID=$UID_A
AGENT_GID=$GID_A
DATA_DIR=$DATA_DIR
TZ=$TZ_VAL
AGENTS_SUBNET=$SUBNET
COMPOSE_PROFILES=$( [ "$BROWSER" = 1 ] && echo browser )
BROWSER_ALLOWED_ORIGINS=$ORIGINS
AGENTS_CPUS=$(env_get AGENTS_CPUS | grep . || echo 1.5)
AGENTS_MEMORY=$(env_get AGENTS_MEMORY | grep . || echo 1g)
BROWSER_CPUS=$(env_get BROWSER_CPUS | grep . || echo 2.0)
BROWSER_MEMORY=$(env_get BROWSER_MEMORY | grep . || echo 1g)"
if [ "$DRY" = 1 ]; then
  echo "${c_dim}    [dry-run] write .env:${c_off}"; echo "$ENV_CONTENT" | sed -E 's/^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|UI_PASSWORD)=.+/\1=<hidden>/; s/^/      /'
else
  (umask 077; printf '%s\n' "$ENV_CONTENT" > .env); chown root:root .env; chmod 600 .env
fi
info ".env written (600) ✓"

# ---------- firewall ----------
step "LAN firewall"
if [ "$FIREWALL" = 0 ]; then
  warn "skipped (--no-firewall): agents can reach your local network"
elif ! command -v iptables >/dev/null; then
  warn "iptables not found; skipping. Agents can reach your local network."
else
  run install -m 755 firewall/claude-agents-firewall "$FW_BIN"
  run mkdir -p "$ETC_DIR"
  if [ "$DRY" = 1 ]; then echo "${c_dim}    [dry-run] write $ETC_DIR/firewall.env: AGENTS_SUBNET=$SUBNET${c_off}"
  else echo "AGENTS_SUBNET=$SUBNET" > "$ETC_DIR/firewall.env"
       [ -f "$ETC_DIR/firewall-allow" ] || printf '# IP:PORT exceptions the agents may reach on your LAN, one per line\n# 192.168.1.50:8123\n' > "$ETC_DIR/firewall-allow"; fi
  if command -v systemctl >/dev/null && [ -d /run/systemd/system ]; then
    run install -m 644 firewall/claude-agents-firewall.service "$FW_UNIT"
    run systemctl daemon-reload
    run systemctl enable claude-agents-firewall >/dev/null
    run systemctl restart claude-agents-firewall
    info "active, and re-applied at every boot (systemd) ✓"
  else
    run "$FW_BIN" "$SUBNET"
    warn "no systemd: rules are active now but NOT persistent across reboots"
  fi
fi

# ---------- start ----------
step "Building and starting (first build takes a few minutes on a Pi)"
run docker compose build --pull
[ "$BROWSER" = 1 ] && run docker compose pull browser-admaster
run docker compose up -d --remove-orphans
[ "$BROWSER" = 0 ] && run docker rm -f browser-admaster >/dev/null 2>&1 || true

# ---------- verify ----------
step "Verifying safeguards"
if [ "$DRY" = 1 ]; then info "[dry-run] would run scripts/verify.sh"
else sleep 3; bash scripts/verify.sh || warn "some checks failed, see above"; fi

step "Done"
LAN_IP=$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')
echo "    Chat UI:       http://${LAN_IP:-<this-server>}:$UI_PORT"
if [ "$UI_NEW_PASSWORD" = 1 ]; then echo "    UI password:   $UI_PASSWORD   (saved in .env as UI_PASSWORD)"; else echo "    UI password:   unchanged (UI_PASSWORD in .env)"; fi
cat <<EOF
    Manage agents: docker exec -it claude-agents agents help
    Create one:    docker exec -it claude-agents agents ask agent-architect "an agent that ..."
    Run one now:   docker exec -it claude-agents agents run release-watch
    Logs:          docker logs -f claude-agents
    Reports:       $DATA_DIR/agents/workspaces/<agent>/reports/
EOF
[ "$BROWSER" = 1 ] && echo "    Logins:        edit secrets/admaster.env, then: docker compose restart browser-admaster"
exit 0
