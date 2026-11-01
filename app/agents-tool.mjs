// MCP server "agents": lets an agent inspect the team, propose new agents
// or changes, disable an agent, and ask another agent for help.
// In-process for Claude (createAgentsServer); served over local HTTP for Codex (createAgentsMcpServer).
//
// Granted only by a human (tool "mcp__agents"). Nothing here can apply a create/update:
// those become proposals that a human approves (UI or `agents approve <id>`).
// New agents inherit the model and effort their creator is running with.
//
// MCP server "self": every agent gets it. It lets an agent read and edit its own profile:
// the name shown in the UI and its description apply at once; new instructions (its responsibilities)
// apply at once only when the human asked in a direct chat, otherwise they become a proposal.
// It can't touch tools, schedule, model or effort.

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { validateAgent, validateProfile, GRANTABLE_BUILTINS, LIMITS, EFFORTS, diff } from "./store.mjs";

const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

/**
 * Plain handlers (testable without a model).
 * ctx: { store, registry, caller, model, effort, depth, askAgent(name, message, depth) }
 */
export function makeHandlers(ctx) {
  const { store, registry, caller } = ctx;
  const summary = (a) => ({
    name: a.name, display_name: a.displayName || a.name, description: a.description, enabled: a.enabled,
    schedule: a.schedule ?? "on demand", model: a.model, effort: a.effort, tools: a.tools,
  });

  return {
    list_agents: async () => text(JSON.stringify(store.list().map(summary), null, 2)),

    get_agent: async ({ name }) => {
      const a = store.get(name);
      return a ? text(JSON.stringify({ ...summary(a), prompt: a.prompt }, null, 2)) : text(`No agent "${name}".`, true);
    },

    list_capabilities: async () => text(JSON.stringify({
      grantable_builtin_tools: GRANTABLE_BUILTINS,
      mcp_servers: Object.fromEntries(Object.entries(registry).map(([k, v]) => [`mcp__${k}`, v.description ?? ""])),
      max_scheduled_runs_per_hour: LIMITS.agent.maxRunsPerHour,
      new_agents_inherit: { model: ctx.model, effort: ctx.effort, note: "the human can change these later from the chat" },
      notes: [
        "Bash and mcp__agents can only be granted by the human.",
        "Read/Write are always limited to the agent's own workspace folder.",
        "schedule is a 5-field cron in the server's timezone, or null for on-demand agents.",
        "Every create/update you propose waits for the human's approval.",
      ],
    }, null, 2)),

    propose_agent: async (args) => {
      const { reason, ...cfg } = args;
      if (store.get(cfg.name)) return text(`Agent "${cfg.name}" already exists. Use propose_update instead.`, true);
      const { errors, agent } = validateAgent({ ...cfg, model: ctx.model, effort: ctx.effort }, "agent", registry);
      if (errors.length) return text(`Not valid, fix and retry:\n- ${errors.join("\n- ")}`, true);
      try {
        const id = store.propose("create", agent, reason, caller);
        return text(`Proposal #${id} created for new agent "${agent.name}" (${agent.model}, ${agent.effort} effort, inherited from you). ` +
          `It is NOT active until the human approves it in the Approvals tab. Tell the user what you proposed and why.`);
      } catch (e) { return text(e.message, true); }
    },

    propose_update: async (args) => {
      const { name, reason, ...changes } = args;
      const current = store.get(name);
      if (!current) return text(`No agent "${name}".`, true);
      const merged = { ...current, ...Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)) };
      const { errors, agent } = validateAgent(merged, "agent", registry, current.tools);
      if (errors.length) return text(`Not valid, fix and retry:\n- ${errors.join("\n- ")}`, true);
      const d = diff(current, agent);
      if (!Object.keys(d).length) return text("No changes compared to the current configuration.", true);
      try {
        const id = store.propose("update", agent, reason, caller);
        return text(`Proposal #${id} created to change "${name}": ${Object.keys(d).join(", ")}. Waiting for the human's approval.`);
      } catch (e) { return text(e.message, true); }
    },

    // Reducing capability is safe, so disabling applies immediately (and is logged).
    disable_agent: async ({ name, reason }) => {
      if (!store.get(name)) return text(`No agent "${name}".`, true);
      store.setEnabled(name, false, `${caller}: ${reason}`);
      return text(`Agent "${name}" disabled. The human can re-enable it.`);
    },

    ask_agent: async ({ name, message }) => {
      if (name === caller) return text("An agent cannot ask itself.", true);
      if (ctx.depth >= 1) return text("Agents started by another agent cannot ask further agents (prevents loops).", true);
      const target = store.get(name);
      if (!target) return text(`No agent "${name}".`, true);
      if (!target.enabled) return text(`Agent "${name}" is disabled.`, true);
      store.event(caller, "ask", name, { message: message.slice(0, 4000) });
      const reply = (await ctx.askAgent(name, `Request from agent "${caller}":\n\n${message}`, ctx.depth + 1)) ?? "(no reply)";
      store.event(name, "reply", caller, { reply: reply.slice(0, 4000) });
      return text(reply);
    },
  };
}

/** The tools as [name, description, zod shape, handler], for either kind of server. */
function agentsTools(ctx) {
  const h = makeHandlers(ctx);
  const agentFields = {
    description: z.string().max(300).describe("One line: what this agent does"),
    schedule: z.string().nullable().describe('5-field cron like "30 8 * * *", or null for on-demand'),
    tools: z.array(z.string()).describe("Least privilege: only what the job needs. See list_capabilities."),
    prompt: z.string().min(20).max(LIMITS.promptMax)
      .describe("Complete standalone instructions; the agent has no memory between runs except files in its workspace"),
  };
  return [
    ["list_agents", "List all agents with schedule, model, effort and tools.", {}, h.list_agents],
    ["get_agent", "Show one agent's full configuration including its prompt.", { name: z.string() }, h.get_agent],
    ["list_capabilities", "What tools and MCP servers may be granted, and the limits.", {}, h.list_capabilities],
    ["propose_agent", "Propose a NEW agent. Becomes active only after the human approves.",
      { name: z.string().describe("lowercase-with-dashes"), ...agentFields, reason: z.string().describe("Why this agent is needed") },
      h.propose_agent],
    ["propose_update", "Propose changes to an existing agent (only the fields you pass change). Needs human approval.",
      {
        name: z.string(),
        ...Object.fromEntries(Object.entries(agentFields).map(([k, v]) => [k, v.optional()])),
        enabled: z.boolean().optional(),
        reason: z.string(),
      },
      h.propose_update],
    ["disable_agent", "Disable an agent immediately (e.g. it is misbehaving or no longer needed).",
      { name: z.string(), reason: z.string() }, h.disable_agent],
    ["ask_agent", "Ask another agent to do something and wait for its answer.",
      { name: z.string(), message: z.string().max(4000) }, h.ask_agent],
  ];
}

/**
 * Handlers for the "self" server.
 * ctx: { store, registry, caller, trigger, depth }
 */
export function makeSelfHandlers(ctx) {
  const { store, registry, caller } = ctx;
  // The human talking to this agent directly (UI chat or `agents ask`), not a schedule, group or other agent.
  const fromHuman = ctx.depth === 0 && (ctx.trigger === "chat" || ctx.trigger === "ask:human");

  return {
    get_profile: async () => {
      const a = store.get(caller);
      return text(JSON.stringify({
        id: a.name, display_name: a.displayName || a.name, description: a.description, prompt: a.prompt,
        note: "The id never changes (it names your workspace and chat). display_name is what the human sees.",
      }, null, 2));
    },

    update_profile: async ({ display_name, description, prompt, reason }) => {
      const current = store.get(caller);
      const { errors, profile } = validateProfile({ displayName: display_name, description, prompt });
      if (errors.length) return text(`Not valid, fix and retry:\n- ${errors.join("\n- ")}`, true);
      const { prompt: newPrompt, ...instant } = profile;
      const actor = `${caller} (self${reason ? `: ${reason.slice(0, 200)}` : ""})`;
      const out = [];

      const changed = store.setProfile(caller, fromHuman ? profile : instant, actor);
      const labels = { displayName: "display name", description: "description", prompt: "instructions" };
      if (changed.length) out.push(`Saved: ${changed.map((k) => labels[k]).join(", ")}.` +
        (changed.some((k) => k !== "prompt") ? " The human sees it in the sidebar right away." : ""));

      if (newPrompt !== undefined && !fromHuman && newPrompt !== current.prompt) {
        const { errors: invalid, agent } = validateAgent({ ...current, prompt: newPrompt }, "agent", registry, current.tools);
        if (invalid.length) return text(`Not valid, fix and retry:\n- ${invalid.join("\n- ")}`, true);
        try {
          const id = store.propose("update", agent, reason || "Update my instructions", caller);
          out.push(`New instructions need the human's approval (you weren't asked directly by them): proposal #${id}.`);
        } catch (e) { return text(e.message, true); }
      }
      if (!out.length) return text("Nothing changed: that is already your profile.");
      if (changed.includes("prompt")) out.push("Your new instructions apply from your next message.");
      return text(out.join("\n"));
    },
  };
}

function selfTools(ctx) {
  const h = makeSelfHandlers(ctx);
  return [
    ["get_profile", "Your own profile: id, display name, description and full instructions (prompt).", {}, h.get_profile],
    ["update_profile",
      "Change your own name, description or instructions when the human asks you to. Only the fields you pass change. " +
      "Read get_profile first: prompt replaces your whole instructions, so keep what still applies.",
      {
        display_name: z.string().max(60).optional().describe('Name shown to the human, e.g. "Matias, the Market Researcher". Empty string resets it to your id.'),
        description: z.string().max(300).optional().describe("One line: what you do (shown under your name)"),
        prompt: z.string().min(20).max(LIMITS.promptMax).optional()
          .describe("Your complete new instructions/responsibilities, standalone (replaces the old ones)"),
        reason: z.string().max(300).optional().describe("Why, in a few words (logged)"),
      },
      h.update_profile],
  ];
}

const instructions = (ctx) =>
  "Manage the team of agents on this server. You can look at agents, propose new ones or changes " +
  "(the human must approve), disable an agent, and ask another agent for help. " +
  `New agents inherit your model and effort (${ctx.model}, ${ctx.effort}); effort levels: ${Object.keys(EFFORTS).join(", ")}.`;

const selfInstructions = "Your own profile. When the human asks you to change your name, description or " +
  "responsibilities, save it with update_profile so it shows in the app and lasts beyond this conversation.";

const sdkServer = (name, instructions, tools) => createSdkMcpServer({
  name, version: "1.1.0", instructions,
  tools: tools.map(([n, desc, shape, handler]) => tool(n, desc, shape, handler)),
});
const mcpServer = (name, instructions, tools) => {
  const server = new McpServer({ name, version: "1.1.0" }, { instructions });
  for (const [n, description, inputSchema, handler] of tools) server.registerTool(n, { description, inputSchema }, handler);
  return server;
};

/** In-process servers for the Claude Agent SDK. */
export const createAgentsServer = (ctx) => sdkServer("agents", instructions(ctx), agentsTools(ctx));
export const createSelfServer = (ctx) => sdkServer("self", selfInstructions, selfTools(ctx));

/** Standard MCP servers, for Codex (which can't load in-process servers). Connect one to a transport. */
export const createAgentsMcpServer = (ctx) => mcpServer("agents", instructions(ctx), agentsTools(ctx));
export const createSelfMcpServer = (ctx) => mcpServer("self", selfInstructions, selfTools(ctx));
