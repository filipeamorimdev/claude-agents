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
      "Headless Chromium: each agent gets its own, which stays signed in. " +
      "To log in, type the login NAMES from list_logins (e.g. OLX_PASSWORD); the real values are filled in for you.",
    config: { type: "http", url: "http://browser-admaster:8931/mcp" },
    logins: true, // fills in the vault's logins: its agents get list_logins and request_login
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
