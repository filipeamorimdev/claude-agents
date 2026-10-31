// In-process MCP server "agents": lets an agent inspect the team, propose new agents
// or changes, disable an agent, and ask another agent for help.
//
// Granted only by a human (tool "mcp__agents"). Nothing here can apply a create/update:
// those become proposals that a human approves (UI or `agents approve <id>`).
// New agents inherit the model and effort their creator is running with.

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { validateAgent, GRANTABLE_BUILTINS, LIMITS, EFFORTS, diff } from "./store.mjs";

const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

/**
 * Plain handlers (testable without a model).
 * ctx: { store, registry, caller, model, effort, depth, askAgent(name, message, depth) }
 */
export function makeHandlers(ctx) {
  const { store, registry, caller } = ctx;
  const summary = (a) => ({
    name: a.name, description: a.description, enabled: a.enabled,
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

export function createAgentsServer(ctx) {
  const h = makeHandlers(ctx);
  const agentFields = {
    description: z.string().max(300).describe("One line: what this agent does"),
    schedule: z.string().nullable().describe('5-field cron like "30 8 * * *", or null for on-demand'),
    tools: z.array(z.string()).describe("Least privilege: only what the job needs. See list_capabilities."),
    prompt: z.string().min(20).max(LIMITS.promptMax)
      .describe("Complete standalone instructions; the agent has no memory between runs except files in its workspace"),
  };
  return createSdkMcpServer({
    name: "agents",
    version: "1.1.0",
    instructions:
      "Manage the team of agents on this server. You can look at agents, propose new ones or changes " +
      "(the human must approve), disable an agent, and ask another agent for help. " +
      `New agents inherit your model and effort (${ctx.model}, ${ctx.effort}); effort levels: ${Object.keys(EFFORTS).join(", ")}.`,
    tools: [
      tool("list_agents", "List all agents with schedule, model, effort and tools.", {}, h.list_agents),
      tool("get_agent", "Show one agent's full configuration including its prompt.", { name: z.string() }, h.get_agent),
      tool("list_capabilities", "What tools and MCP servers may be granted, and the limits.", {}, h.list_capabilities),
      tool("propose_agent", "Propose a NEW agent. Becomes active only after the human approves.",
        { name: z.string().describe("lowercase-with-dashes"), ...agentFields, reason: z.string().describe("Why this agent is needed") },
        h.propose_agent),
      tool("propose_update", "Propose changes to an existing agent (only the fields you pass change). Needs human approval.",
        {
          name: z.string(),
          ...Object.fromEntries(Object.entries(agentFields).map(([k, v]) => [k, v.optional()])),
          enabled: z.boolean().optional(),
          reason: z.string(),
        },
        h.propose_update),
      tool("disable_agent", "Disable an agent immediately (e.g. it is misbehaving or no longer needed).",
        { name: z.string(), reason: z.string() }, h.disable_agent),
      tool("ask_agent", "Ask another agent to do something and wait for its answer.",
        { name: z.string(), message: z.string().max(4000) }, h.ask_agent),
    ],
  });
}
