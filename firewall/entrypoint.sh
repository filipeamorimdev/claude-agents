#!/bin/sh
# Firewall container (network_mode: host, NET_ADMIN): applies the LAN rules on the host,
# re-applies them if they disappear, and stays up so the agents can wait for it to be healthy.
#   (no args)   apply and watch
#   remove      remove the rules and exit
# Stopping the container leaves the rules in place, so the agents stay fenced.
#
# Two networks:
#   AGENTS_SUBNET  the app, the vault and the browsers: no LAN, except FIREWALL_ALLOW (for connectors in
#                  config/mcp-servers.mjs)
#   SHELL_SUBNET   the command sandbox and the LAN gateway: no LAN, except the targets you granted to agents,
#                  and those only from the gateway (LAN_GATEWAY_IP), never from the sandbox itself. The list comes
#                  from the gateway (GET /allow) and is checked every few seconds, so a grant or a revoke applies
#                  within seconds. If the gateway can't be asked, the last list stays.
set -u
SUBNET=${AGENTS_SUBNET:-172.30.0.0/24}
SHELL_NET=${SHELL_SUBNET:-}
GATEWAY=${LAN_GATEWAY_IP:-}
FW=/usr/local/sbin/claude-agents-firewall
LAN_LIST=/tmp/lan-allow        # what the gateway may reach (IP:PORT per line)
touch "$LAN_LIST"
shell_fw() {
  [ -z "$SHELL_NET" ] && return 0
  if [ -n "$GATEWAY" ]; then FIREWALL_ALLOW= ALLOW_FILE="$LAN_LIST" ALLOW_SRC="$GATEWAY" "$FW" "$@" "$SHELL_NET"
  else FIREWALL_ALLOW= ALLOW_FILE=/dev/null "$FW" "$@" "$SHELL_NET"; fi
}
apply() { "$FW" "$SUBNET" && shell_fw; }

# The gateway's list. Prints nothing (and fails) when it can't be asked.
fetch_lan() {
  [ -n "$GATEWAY" ] || return 1
  wget -q -T 3 -O - "http://$GATEWAY:8934/allow" 2>/dev/null
}

# Use the iptables backend the host's Docker uses (nft or legacy).
IPT=iptables
for b in nft legacy; do
  if "iptables-$b-save" 2>/dev/null | grep -q DOCKER; then IPT=iptables-$b; break; fi
done
export IPT

if [ "${1:-}" = remove ]; then shell_fw --remove; exec "$FW" --remove "$SUBNET"; fi

trap 'exit 0' TERM INT
idle() { while :; do sleep 3600 & wait $!; done; }

if [ "${FIREWALL:-on}" = off ]; then
  "$FW" --remove "$SUBNET" >/dev/null 2>&1 || true
  shell_fw --remove >/dev/null 2>&1 || true
  echo "FIREWALL=off: the agents CAN reach your local network and this host"
  touch /tmp/ready; idle
fi

echo "using $IPT"
apply || { echo "could not apply the firewall; on hosts without iptables set FIREWALL=off" >&2; exit 1; }
touch /tmp/ready
n=0
while :; do
  sleep 5 & wait $!
  # A grant changed: the sandbox network's rules are replaced in one step (never a moment without them)
  if list=$(fetch_lan); then
    if [ "$list" != "$(cat "$LAN_LIST")" ]; then
      printf '%s\n' "$list" | grep -v '^$' > "$LAN_LIST" || true
      echo "LAN gateway may reach: $(tr '\n' ' ' < "$LAN_LIST")"
      if QUIET=1 shell_fw; then touch /tmp/ready; else rm -f /tmp/ready; fi
    fi
  fi
  n=$((n + 1))
  if [ $((n % 12)) = 0 ]; then
    if ! "$FW" --check "$SUBNET" || ! shell_fw --check; then
      echo "rules missing, re-applying"
      if apply; then touch /tmp/ready; else rm -f /tmp/ready; fi
    fi
  fi
done
