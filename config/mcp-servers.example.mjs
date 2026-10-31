// MCP servers that agents may use. Copied to DATA_DIR/config/mcp-servers.mjs on first start.
//
// This list is human-controlled: agents can only reference servers defined HERE
// (an agent can never add a new server URL or command). After editing:
//   docker compose restart claude-agents
//
// Give an agent a server by adding "mcp__<name>" to its tools.

export const mcpServers = {
  browser: {
    description:
      "Headless Chromium with persistent logins (the ad master's browser). " +
      "To log in, type the secret NAMES OLX_EMAIL / OLX_PASSWORD; the real values are filled in for you.",
    config: { type: "http", url: "http://browser-admaster:8931/mcp" },
  },

  // Example: Home Assistant. Also add its IP:8123 to FIREWALL_ALLOW, and set HA_TOKEN in the
  // stack's variables (a variable only reaches the container if compose.yaml lists it).
  // homeassistant: {
  //   description: "Read and control Home Assistant entities",
  //   config: {
  //     type: "http",
  //     url: "http://192.168.1.50:8123/api/mcp",
  //     headers: { Authorization: `Bearer ${process.env.HA_TOKEN}` },
  //   },
  // },
};
