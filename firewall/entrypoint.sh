#!/bin/sh
# Firewall container (network_mode: host, NET_ADMIN): applies the LAN rules on the host,
# re-applies them if they disappear, and stays up so the agents can wait for it to be healthy.
#   (no args)   apply and watch
#   remove      remove the rules and exit
# Stopping the container leaves the rules in place, so the agents stay fenced.
set -u
SUBNET=${AGENTS_SUBNET:-172.30.0.0/24}
FW=/usr/local/sbin/claude-agents-firewall

# Use the iptables backend the host's Docker uses (nft or legacy).
IPT=iptables
for b in nft legacy; do
  if "iptables-$b-save" 2>/dev/null | grep -q DOCKER; then IPT=iptables-$b; break; fi
done
export IPT

if [ "${1:-}" = remove ]; then exec "$FW" --remove "$SUBNET"; fi

trap 'exit 0' TERM INT
idle() { while :; do sleep 3600 & wait $!; done; }

if [ "${FIREWALL:-on}" = off ]; then
  "$FW" --remove "$SUBNET" >/dev/null 2>&1 || true
  echo "FIREWALL=off: the agents CAN reach your local network and this host"
  touch /tmp/ready; idle
fi

echo "using $IPT"
"$FW" "$SUBNET" || { echo "could not apply the firewall; on hosts without iptables set FIREWALL=off" >&2; exit 1; }
touch /tmp/ready
while :; do
  sleep 60 & wait $!
  if ! "$IPT" -C DOCKER-USER -s "$SUBNET" -j CLAUDE-AGENTS 2>/dev/null \
     || ! "$IPT" -C INPUT -s "$SUBNET" -j CLAUDE-AGENTS-IN 2>/dev/null; then
    echo "rules missing, re-applying"
    "$FW" "$SUBNET" || rm -f /tmp/ready
  fi
done
