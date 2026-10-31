# Applies the claude-agents LAN firewall on the host. Runs with network_mode: host + NET_ADMIN.
FROM alpine:3.22
RUN apk add --no-cache iptables iptables-legacy
COPY claude-agents-firewall /usr/local/sbin/claude-agents-firewall
COPY entrypoint.sh /entrypoint.sh
RUN chmod 755 /usr/local/sbin/claude-agents-firewall /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
