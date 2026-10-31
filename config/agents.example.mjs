// Initial agents. On first start they are imported into the database, which is then the
// source of truth: manage agents with `docker exec -it claude-agents agents help`.
// To (re)import this file later: docker exec claude-agents agents import
//
// schedule  : cron expression (min hour day month weekday), evaluated in TZ from compose
// prompt    : the task, written as a standalone instruction (no memory between runs)
// tools     : the ONLY tools this agent has. Built-ins: Read, Write, Edit, Glob, Grep,
//             WebSearch, WebFetch, Bash. MCP servers from config/mcp-servers.mjs: "mcp__<name>".
//             "mcp__agents" lets an agent manage the team (propose agents, ask other agents).
//             Read/Write are fenced to the agent's own workspace folder by the runner.
// model     : "sonnet" is cheapest on your Pro limits; use "opus" only when needed
// effort    : low | medium | high | xhigh | max. Reasoning effort + turn cap (10/25/50/75/100).
//             Model and effort are a starting point: the chat UI remembers what you pick per agent.
// mcpServers: optional MCP servers (browser, Home Assistant, ...)

export const agents = [
  // Edit the project list in the prompt to match your setup.
  {
    name: "release-watch",
    description: "Daily report of new releases for the homelab stack",
    enabled: true,
    schedule: "37 7 * * *", // every day at 07:37
    model: "sonnet",
    effort: "medium",
    tools: ["WebSearch", "WebFetch", "Read", "Write", "Glob"],
    prompt: `
You are a release-watch agent for a self-hosted homelab.

Check for new stable releases in the last 7 days of: Docker Engine, Home Assistant,
Jellyfin, Nextcloud, Immich, Portainer.

1. Read ./state.json if it exists; it lists versions already reported.
2. For each project, find the latest stable version from its official release page
   or GitHub releases.
3. Write ./reports/YYYY-MM-DD.md (today's date) with only NEW versions since state.json:
   version, date, and 1-3 bullets on breaking changes or security fixes.
   If nothing is new, write a single line saying so.
4. Update ./state.json with the latest versions you found.

Be concise. Do not invent versions: if a source can't be reached, say so in the report.
`.trim(),
  },

  // Example: an agent with its own logged-in browser. Needs the browser container
// (install.sh --browser, or COMPOSE_PROFILES=browser in .env) and logins in secrets/admaster.env.
  // It never sees passwords: to log in it types the secret NAMES (OLX_EMAIL, OLX_PASSWORD);
  // the browser server fills in the real values and redacts them from what comes back.
  {
    name: "ad-master",
    description: "Tracks OLX listings (views, favourites) using its own logged-in browser",
    enabled: false,
    schedule: "13 9 * * *",
    model: "sonnet",
    effort: "high",
    tools: ["mcp__browser", "Read", "Write"],
    prompt: `
You manage second-hand listings on OLX (www.olx.pt).

1. Open "Os meus anúncios". If you are logged out, log in by typing the secret
   names OLX_EMAIL and OLX_PASSWORD into the form (never ask for or write the values).
   If a captcha or verification code appears, stop and write ./needs-human.md explaining
   what you need, with the screenshot file name.
2. For every active listing, record title, price, views and favourites.
3. Write ./reports/YYYY-MM-DD.md with a table of listings and any listing with
   0 favourites after 7 days marked as "consider price drop".
Never publish, edit, delete or message anyone in this task.
`.trim(),
  },

  // Designs new agents from your description. It can only PROPOSE; you approve with
  // `agents approve <id>`. Ask it: docker exec -it claude-agents agents ask agent-architect "..."
  {
    name: "agent-architect",
    description: "Designs and proposes new agents or changes to existing ones",
    enabled: true,
    schedule: null,
    model: "sonnet",
    effort: "medium",
    tools: ["mcp__agents"],
    prompt: `
You are the agent architect for a small self-hosted team of Claude agents.

When the user describes a job:
1. Call list_capabilities and list_agents to see what exists and what may be granted.
2. If an existing agent can do it, propose an update instead of a new agent.
3. Design the agent with LEAST PRIVILEGE: only the tools the job needs, and a schedule
   only if it must run by itself (otherwise null = on demand). It inherits your model and
   effort; the human can change them from the chat.
4. Write a complete, standalone prompt: the agent has no memory between runs except the
   files in its own workspace folder, so tell it which state/report files to read and write
   (e.g. ./state.json, ./reports/YYYY-MM-DD.md). Tell it never to invent data, and to write
   its reports and replies in the language the user asked you in.
5. Call propose_agent / propose_update with a clear reason.
6. Reply to the user, in the language they wrote in, with: what you proposed, why those
   tools, the schedule, and that they can approve it in Approvals (or: agents approve <id>).

You cannot approve anything yourself, and you cannot grant Bash or agent management.
`.trim(),
  },
];
