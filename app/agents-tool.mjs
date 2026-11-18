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
// and its schedule apply at once only when the human asked in a direct chat, otherwise they become a proposal.
// It can give up tools at once (except the base tools every agent has), but getting a tool is always a proposal.
// It can't touch model or effort.
// An agent with a browser that fills in vault logins also gets list_logins and request_login here:
// it sees login NAMES only, and only the logins the human granted it; it asks for a missing one with a form
// under its reply (logins.mjs). The browser's guard refuses any other login name it types.
// Every agent also keeps a memory (remember/forget: notes shown on every run, editable by the human), and can
// stop mid-run to ask the human: request_approval for an OK, request_takeover to have them act in its browser.
// Every agent can read its own log (read_log). The log is append-only: no tool here, or anywhere, changes or
// deletes an entry, and the database refuses it (store.mjs). Only the human purges it.
// Every agent can ask to run a terminal command (run_command). Each command waits for the human's OK in the chat, unless
// a command rule the human set for that agent auto-approves it (command-rules.mjs; none by default). It runs in the
// command sandbox (shell.mjs), never in this container, and the request, who (or which rule) approved it and when,
// the command, its exit code and output all go to the log. Its home network: nothing, unless the human granted the
// agent targets (each one IP and port) in the LAN gateway (lan.mjs); network_access tells it what it has.
// "agents" also has delegate/check_tasks/wait_for_tasks: background tasks for other agents (tasks.mjs).

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { validateAgent, validateProfile, GRANTABLE_BUILTINS, HUMAN_ONLY_TOOLS, BASE_TOOLS, LIMITS, EFFORTS, MEMORY_TEXT_MAX, SHELL_TOOL, AUTO_APPROVED, diff } from "./store.mjs";
import { COMMAND_MAX, TIMEOUT_DEFAULT, TIMEOUT_MAX } from "./shell.mjs";
import { LOGIN_NAME_RE, siteAllowed, deviceOf, loginSite } from "./logins.mjs";
import { validateTarget, TARGET_ID_RE } from "./lan.mjs";

/** Marks an approval request that asks for a device on the human's network (request_network_access), for the UI. */
export const LAN_TOOL = "LAN";
/** Marks a request for a device's key (request_device_key): the human pastes it, or makes an SSH key, right in the chat card. */
export const LAN_KEY_TOOL = "LAN_KEY";
/** Marks a request to override rule zero for one use of private data (request_private_data): only the human's click allows it. */
export const PRIVATE_TOOL = "PRIVATE";

// Tools an agent can ask for: the built-ins plus the human's MCP servers.
const grantable = (registry) => [...GRANTABLE_BUILTINS, ...Object.keys(registry).map((k) => `mcp__${k}`)];
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
        `Every agent always has ${BASE_TOOLS.join(", ")}; list only what it needs beyond that.`,
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
      const { errors, agent } = validateAgent(merged, "agent", registry, current);
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

    // Delegation (tasks.mjs): the other agent works in the background while this one carries on.
    delegate: async ({ name, task }) => {
      if (name === caller) return text("An agent cannot delegate to itself.", true);
      if (ctx.depth >= 1) return text("Agents started by another agent (or by tasks coming back) cannot delegate (prevents loops).", true);
      const target = store.get(name);
      if (!target) return text(`No agent "${name}".`, true);
      if (!target.enabled) return text(`Agent "${name}" is disabled.`, true);
      try {
        const id = ctx.delegate(name, task);
        return text(`Task #${id} given to ${name}; it's working on it in the background. Delegate other tasks now if you have them ` +
          "(they run at the same time), then call wait_for_tasks to collect the results. If you end your turn first, the results come back to you " +
          "in a new message once every task has ended.");
      } catch (e) { return text(e.message, true); }
    },

    check_tasks: async ({ ids }) => {
      const list = store.tasksFrom(caller, ids?.length ? ids : null);
      if (!list.length) return text("You have no tasks.");
      store.markTasksReported(list.filter((t) => t.status === "done" || t.status === "failed").map((t) => t.id));
      return text(JSON.stringify(list.map(taskView), null, 2));
    },

    wait_for_tasks: async ({ ids, minutes = 10 }) => {
      const wanted = () => store.tasksFrom(caller, ids?.length ? ids : null).filter((t) => ids?.length || !t.reported);
      for (const until = Date.now() + Math.min(minutes, 10) * 60e3; Date.now() < until;) {
        if (wanted().every((t) => t.status === "done" || t.status === "failed")) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
      const list = wanted();
      if (!list.length) return text("No tasks to wait for.");
      store.markTasksReported(list.filter((t) => t.status === "done" || t.status === "failed").map((t) => t.id));
      const open = list.filter((t) => t.status === "queued" || t.status === "running").length;
      return text((open ? `${open} task(s) still in progress: wait again or carry on (their results come back to you later).\n` : "") +
        JSON.stringify(list.map(taskView), null, 2));
    },
  };
}

const taskView = (t) => ({ id: t.id, to: t.to, task: t.text, status: t.status, ...(t.result != null ? { result: t.result } : {}) });

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
    ["delegate", "Give another agent a task to do in the background, and carry on. Several delegated tasks run at the same time. " +
      "Collect the results with wait_for_tasks (or check_tasks).",
      { name: z.string(), task: z.string().min(10).max(4000).describe("Complete and self-contained: the other agent sees only this") }, h.delegate],
    ["check_tasks", "The status (and results, when done) of the tasks you delegated. Doesn't wait.",
      { ids: z.array(z.number().int()).optional().describe("Only these tasks (default: your recent ones)") }, h.check_tasks],
    ["wait_for_tasks", "Wait until the tasks you delegated have ended (at most `minutes`), then get their results.",
      { ids: z.array(z.number().int()).optional().describe("Only these tasks (default: those whose results you haven't seen)"),
        minutes: z.number().min(1).max(10).optional().describe("How long to wait at most (default 10)") }, h.wait_for_tasks],
  ];
}

/**
 * Handlers for the "self" server.
 * ctx: { store, registry, caller, trigger, depth, tz, vault (only for agents whose browser uses vault logins) }
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
        schedule: a.schedule ?? "on demand", timezone: ctx.tz ?? "UTC",
        tools: a.tools, always_has: BASE_TOOLS, can_request_tools: grantable(registry).filter((t) => !a.tools.includes(t)),
        note: "The id never changes (it names your workspace and chat). display_name is what the human sees. " +
          "On a scheduled run your instructions are the only message you get.",
      }, null, 2));
    },

    // Giving up a tool is safe and applies at once; getting one is always a proposal the human approves.
    change_tools: async ({ add = [], remove = [], reason }) => {
      const current = store.get(caller);
      const known = [...grantable(registry), ...HUMAN_ONLY_TOOLS];
      const unknown = [...add, ...remove].filter((t) => !known.includes(t));
      if (unknown.length) return text(`Unknown tool${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")} (available: ${known.join(", ")})`, true);
      const out = [];
      const actor = `${caller} (self${reason ? `: ${reason.slice(0, 200)}` : ""})`;
      const fixed = remove.filter((t) => BASE_TOOLS.includes(t));
      if (fixed.length) out.push(`Kept ${fixed.join(", ")}: every agent always has ${BASE_TOOLS.join(", ")}.`);

      const kept = current.tools.filter((t) => !remove.includes(t) || BASE_TOOLS.includes(t));
      const { removed } = store.setTools(caller, kept, actor);
      if (removed.length) out.push(`Removed: ${removed.join(", ")}. Applies from your next message.`);

      const wanted = [...new Set(add)].filter((t) => !kept.includes(t));
      if (wanted.length) {
        const { errors, agent } = validateAgent({ ...current, tools: [...kept, ...wanted] }, "agent", registry, { ...current, tools: kept });
        if (errors.length) return text([...out, `Can't request that:\n- ${errors.join("\n- ")}`].join("\n"), true);
        try {
          const id = store.propose("update", agent, reason || `Let me use ${wanted.join(", ")}`, caller);
          out.push(`Requested ${wanted.join(", ")}: proposal #${id}. The human approves it with the button under your reply (or in the Approvals tab); ` +
            "you can use it from the message after that.");
        } catch (e) { return text([...out, e.message].join("\n"), true); }
      }
      return text(out.join("\n") || `Nothing changed: you already have ${current.tools.join(", ") || "no tools"}.`);
    },

    update_profile: async ({ display_name, description, prompt, schedule, reason }) => {
      const current = store.get(caller);
      const { errors, profile } = validateProfile({ displayName: display_name, description, prompt, schedule });
      if (errors.length) return text(`Not valid, fix and retry:\n- ${errors.join("\n- ")}`, true);
      // Name and description apply at once; instructions and schedule only when the human asked directly.
      const { prompt: newPrompt, schedule: newSchedule, ...instant } = profile;
      const actor = `${caller} (self${reason ? `: ${reason.slice(0, 200)}` : ""})`;
      const out = [];

      const changed = store.setProfile(caller, fromHuman ? profile : instant, actor);
      const labels = { displayName: "display name", description: "description", prompt: "instructions", schedule: "schedule" };
      if (changed.length) out.push(`Saved: ${changed.map((k) => labels[k]).join(", ")}.` +
        (changed.some((k) => k !== "prompt") ? " The human sees it in the app right away." : ""));

      const gated = {};
      if (newPrompt !== undefined && newPrompt !== current.prompt) gated.prompt = newPrompt;
      if (newSchedule !== undefined && newSchedule !== current.schedule) gated.schedule = newSchedule;
      if (!fromHuman && Object.keys(gated).length) {
        const { errors: invalid, agent } = validateAgent({ ...current, ...gated }, "agent", registry, current);
        if (invalid.length) return text(`Not valid, fix and retry:\n- ${invalid.join("\n- ")}`, true);
        try {
          const id = store.propose("update", agent, reason || `Update my ${Object.keys(gated).map((k) => labels[k]).join(" and ")}`, caller);
          const what = Object.keys(gated).map((k) => labels[k]);
          out.push(`Your new ${what.join(" and ")} ${what.length > 1 ? "need" : "needs"} the human's approval (you weren't asked directly by them): proposal #${id}.`);
        } catch (e) { return text(e.message, true); }
      }
      if (!out.length) return text("Nothing changed: that is already your profile.");
      if (changed.includes("prompt")) out.push("Your new instructions apply from your next message.");
      if (changed.includes("schedule")) out.push(current.enabled
        ? (newSchedule ? `You now run by yourself on "${newSchedule}" (${ctx.tz ?? "UTC"}), starting within a few seconds.` : "You no longer run on a schedule.")
        : "Note: you are turned off, so the schedule only starts once the human turns you back on.");
      return text(out.join("\n"));
    },

    list_logins: async () => {
      try {
        const { logins, sites } = await ctx.vault.list();
        return text(JSON.stringify({
          your_logins: logins.filter((l) => l.agents.includes(caller)).map((l) => ({ name: l.name, site: l.site || null })),
          sites_the_browser_can_open: sites.map((s) => s.rule),
          devices_on_the_humans_network_your_browser_can_open: await (async () => {
            try { return ctx.lan ? (await ctx.lan.forAgent(caller)).filter((t) => t.browser).map((t) => `http://${t.host}:${t.port}/ (${t.name}, ${t.mode === "full" ? "full" : "read-only"})`) : []; }
            catch { return []; }
          })(),
          how_to_use: "To sign in, type a login's NAME (e.g. VINTED_PASSWORD) into the form field: the browser types the real value. " +
            "You never see or ask for values, and you can use only the logins listed here. If what you need isn't here, call request_login. " +
              "A device on the human's network that isn't listed: call request_network_access with browser: true first.",
        }, null, 2));
      } catch (e) { return text(e.message, true); }
    },

    request_login: async ({ site, fields, reason, failed = false }) => {
      // A website, or a device on the human's network that its browser was given (request_network_access with browser).
      const device = deviceOf(site);
      const origin = loginSite(site);
      if (!origin) return text(`"${site}" isn't a website address or a device on the human's network. Pass the address, e.g. https://www.vinted.pt or http://192.168.1.1:8443`, true);
      const names = fields.map((f) => f.name);
      if (new Set(names).size !== names.length) return text("Each field needs its own name.", true);
      let listing;
      try { listing = await ctx.vault.list(); } catch (e) { return text(e.message, true); }
      const saved = new Set(listing.logins.filter((l) => l.agents.includes(caller)).map((l) => l.name));
      let allowed;
      if (device) {
        let mine = [];
        try { mine = ctx.lan ? await ctx.lan.forAgent(caller) : []; } catch { mine = []; }
        const t = mine.find((x) => x.host === device.host && x.port === device.port);
        if (!t?.browser) return text(`Your browser can't open ${device.host}:${device.port} yet. Call request_network_access for it with browser: true ` +
          "(and access \"full\": a sign-in form is a POST) first, then ask for the login.", true);
        allowed = true;
      } else allowed = siteAllowed(origin, listing.sites.map((s) => s.rule));
      if (names.every((n) => saved.has(n)) && allowed && !failed) {
        return text(`Already saved: type ${names.join(", ")} into the sign-in form on ${origin}. ` +
          "If the site rejects them, call request_login again with failed: true so the human can type them again.");
      }
      try {
        const id = ctx.store.requestLogin(caller, { site: origin, reason: reason ?? "", fields: fields.map((f) => ({ name: f.name, label: f.label, secret: !!f.secret })) });
        return text(`Asked the human (login request #${id}): a form under your reply lets them type ${names.join(", ")} straight into the vault` +
          `${allowed ? "" : `, and let the browser open ${origin} (it can't yet)`}. You never see the values. ` +
          "Stop here: tell the human in one short sentence that you need their login, and don't ask for it in the chat. " +
          `Once they save it you get a message to carry on; then type the names (${names.join(", ")}) into the sign-in form.`);
      } catch (e) { return text(e.message, true); }
    },

    request_takeover: async ({ reason }, extra) => {
      let r;
      try { r = await ctx.askHuman({ kind: "takeover", title: reason, signal: extra?.signal }); } catch (e) { return text(e.message, true); }
      if (r.status === "done") return text(`The human handed your browser back${r.note ? `: "${r.note}"` : ""}. Take a new snapshot and carry on.`);
      if (r.status === "denied") return text(`The human couldn't do it${r.note ? `: "${r.note}"` : ""}. Stop and tell them where you got to.`);
      return text("The human didn't take over in time. Stop and tell them what they need to do in your browser.");
    },

    remember: async ({ text: note }) => {
      try {
        const id = store.addMemory(caller, note, `${caller} (self)`);
        return text(`Saved as note #${id}. You'll see it on your next runs.`);
      } catch (e) { return text(e.message, true); }
    },

    forget: async ({ id }) => {
      const m = store.memory(id);
      if (!m || m.agent !== caller) return text(`You have no note #${id}.`, true);
      store.deleteMemory(id, `${caller} (self)`);
      return text(`Removed note #${id}.`);
    },

    // A command runs in the command sandbox: a container with the agents' folders and the internet, without the
    // database, the logs, the vault or the stack's secrets (shell.mjs). It waits for the human unless one of the agent's
    // command rules (set by the human only) auto-approves it. LAN access: only the targets the human granted this agent,
    // through the LAN gateway (lan.mjs), with a token that lives as long as this one command.
    run_command: async ({ command, reason, timeout_seconds }, extra) => {
      const cmd = String(command ?? "").trim();
      const seconds = Math.min(Math.max(Math.round(timeout_seconds ?? TIMEOUT_DEFAULT), 1), TIMEOUT_MAX);
      if (!cmd || cmd.length > COMMAND_MAX) return text(`A command is 1 to ${COMMAND_MAX} characters. Put longer scripts in a file in your folder and run that.`, true);
      const why = String(reason ?? "").replace(/\s+/g, " ").trim();
      const record = (kind, line, detail, ok) => ctx.record?.(kind, line, { tool: SHELL_TOOL, detail, ok });
      // What it could reach on the human's network (names and addresses only; never a credential)
      let targets = [];
      if (ctx.lan) { try { targets = await ctx.lan.forAgent(caller); } catch { targets = []; } }
      const reachLine = (list) => list.length ? list.map((t) => `${t.name} ${t.host}:${t.port} (${t.mode === "full" ? "full" : "read-only"})`).join(", ") : "nothing";
      const auto = store.autoApprove(caller, cmd);
      const byRule = auto && !auto.capped ? auto : null;
      const lanCap = byRule ? byRule.lan : "full";
      const lanNote = targets.length
        ? (lanCap === "none" ? "none (the rule that lets it run gives no LAN access)" : `${reachLine(targets.map((t) => ({ ...t, mode: lanCap === "read" ? "read" : t.mode })))}, with \`lan <command>\``)
        : "none";
      const header = `Command:\n${cmd}\n\nWhy: ${why}\nAgent: ${caller}\nWhere: the command sandbox, in ${caller}'s folder, for at most ${seconds}s\nYour network: ${lanNote}`;
      let answered, by;
      if (byRule) {
        const rules = byRule.rules.map((r) => `#${r.id} ${r.kind} \`${r.pattern}\``).join(", ");
        answered = `auto-approved by rule ${rules} (set by the human), at ${new Date().toISOString()}`;
        by = `rule ${byRule.rules.map((r) => `#${r.id}`).join(", ")}`;
      } else {
        let r;
        const title = `Run a command: ${cmd}`;
        const details = auto?.capped ? `${header}\n\n(It matches a rule, but it already ran its hourly maximum of commands without asking.)` : header;
        try { r = await ctx.askHuman({ kind: "tool", tool: SHELL_TOOL, title, details, signal: extra?.signal }); }
        catch (e) { return text(e.message, true); }
        answered = `${r.status} by ${r.decidedBy ?? "nobody"} at ${r.decidedAt ?? "-"}`;
        if (r.status !== "allowed") {
          record("refused", `Command not run (${r.status === "expired" ? "no answer in time" : `denied by ${r.decidedBy}`}): ${cmd}`, `${header}\n\nAnswer: ${answered}${r.note ? `\nNote: ${r.note}` : ""}`, false);
          return text(r.status === "expired" ? "The human didn't answer in time, so the command didn't run. Don't try it another way; tell them what you wanted to run and why."
            : `The human said no to this command${r.note ? `: "${r.note}"` : ""}. Don't try it another way.`, true);
        }
        by = r.decidedBy;
      }
      // LAN access for this one command, if the agent has targets and the approval gives any
      let lan = null;
      if (ctx.lan && targets.length && lanCap !== "none") {
        try { lan = await ctx.lan.open(caller, lanCap, seconds + 30); }
        catch (e) {
          record("result", `Command ${byRule ? AUTO_APPROVED.toLowerCase() : `approved by ${by}`} but not run (${e.message}): ${cmd}`, `${header}\n\nAnswer: ${answered}\n\nNot run: ${e.message}`, false);
          return text(`It was approved, but your network access couldn't be set up: ${e.message}`, true);
        }
      }
      let out;
      try { out = await ctx.shell.run(caller, cmd, seconds, lan?.proxy ?? null); }
      catch (e) {
        record("result", `${byRule ? `${AUTO_APPROVED} (${by})` : `Command approved by ${by}`} but not run (${e.message}): ${cmd}`, `${header}\n\nAnswer: ${answered}\n\nNot run: ${e.message}`, false);
        return text(`Approved, but it couldn't run: ${e.message}`, true);
      } finally { if (lan) ctx.lan.close(lan.token); }
      const how = out.timedOut ? `stopped after ${seconds}s (time up)` : out.exitCode != null ? `exit code ${out.exitCode}` : `ended by ${out.signal}`;
      const ended = out.timedOut ? "timed out" : `exited ${out.exitCode ?? out.signal}`;
      record("result", byRule ? `${AUTO_APPROVED} by ${by}, ${ended}: ${cmd}` : `Command ${ended} (approved by ${by}): ${cmd}`,
        `${header}\n\nAnswer: ${answered}\nResult: ${how}, ${out.seconds}s${out.truncated ? " (output cut in the middle)" : ""}${lan ? `\nLAN access: ${reachLine(lan.targets)}` : ""}\n\nOutput:\n${out.output}`,
        out.exitCode === 0 && !out.timedOut);
      const shown = out.output.length > 20_000 ? `${out.output.slice(0, 8000)}\n… (${out.output.length - 20_000} characters left out) …\n${out.output.slice(-12_000)}` : out.output;
      return text(`${byRule ? "(ran without asking: one of your command rules allows it)\n" : ""}${how} (${out.seconds}s)\n\n${shown || "(no output)"}`, out.exitCode !== 0 || out.timedOut);
    },

    // What this agent may reach on the human's network, and how. Names and addresses only: credentials stay in the gateway.
    network_access: async () => {
      const rules = store.commandRules(caller);
      let targets = [], error = null;
      if (ctx.lan) { try { targets = await ctx.lan.forAgent(caller); } catch (e) { error = e.message; } }
      // Vault logins the human saved for one of these devices and granted to this agent: lan-ssh can sign in with them.
      let mine = [];
      if (targets.length && ctx.deviceLogins) { try { mine = (await ctx.deviceLogins.list()).logins.filter((l) => l.agents.includes(caller)); } catch { /* no vault */ } }
      const loginsFor = (t) => mine.filter((l) => deviceOf(l.site)?.host === t.host).map((l) => l.name);
      const sshOf = (t) => {
        const names = loginsFor(t);
        if (!t.ssh && !(names.length && (t.port === 22 || t.mode === "full"))) return undefined;
        if (t.mode !== "full") return "needs full access, which you don't have";
        return { ...(t.ssh ? { as_user: t.ssh.user, run: `lan-ssh ${t.id} <command>` } : {}),
          ...(names.length ? { vault_logins: names, run_with_password: `lan-ssh -l <user> --login ${names[0]} ${t.id} <command>` } : {}) };
      };
      return text(JSON.stringify({
        your_network_targets: targets.map((t) => ({ name: t.name, address: `${t.host}:${t.port}`, access: t.mode === "full" ? "full" : "read-only (GET, HEAD, OPTIONS)",
          in_your_browser: ctx.vault ? (t.browser ? `open http://${t.host}:${t.port}/` : "no (ask with request_network_access, browser: true)") : undefined,
          service: t.preset !== "other" ? t.preset : undefined, credential_added_for_you: t.credential ? t.credential.header : undefined,
          ssh: sshOf(t),
          note: t.note || undefined })),
        ...(error ? { error } : {}),
        how_to_use: targets.length ? [
          "Only through run_command, and only with the lan prefix: e.g. lan curl -s http://192.168.1.50:8123/api/states",
          "Always write http:// (even for a service on https): the gateway speaks https to it and adds its credential. You never see or send credentials.",
          "Read-only targets take GET, HEAD and OPTIONS only. Full targets also take other methods, and tunnels (lan curl https://...).",
          "SSH: for a target with ssh listed, run `lan-ssh <name> <command>`, e.g. lan-ssh router uptime. The gateway signs in with a key it keeps; you never have or need a key or a password. " +
            "Where ssh lists vault_logins, the gateway can sign in with that saved password instead: `lan-ssh -l <user> --login <NAME> <name> <command>` (the user on the device, e.g. admin; the password stays in the gateway). " +
            "Don't put shell operators in the remote command (; && | quotes): run one plain command per call. For a target without ssh, call request_device_key with kind \"ssh\", " +
            "or ask the human to save the device's password in the vault (its site: http://IP:PORT of that device) and grant it to you.",
          "Anything not listed here is unreachable. If you need another device, call request_network_access with its IP, port and why: the human approves it in the chat.",
        ] : ["You can't reach anything on the human's network yet. If a task needs a device there, call request_network_access with its IP, port and why: the human approves it in the chat."],
        commands_you_may_run_without_asking: rules.map((r) => ({ [r.kind === "exact" ? "exactly" : "starting_with"]: r.pattern, lan: r.lan })),
      }, null, 2));
    },

    // Asks the human to let this agent reach one device (one IP, one port), from its commands and, if it asks, from its
    // browser. Waits for their answer in the chat; on a yes, the device becomes a target in the LAN gateway (or the
    // existing one for that address is reused) and is granted to this agent, never more than the human approved.
    // A credential or SSH key is still the human's to add.
    request_network_access: async ({ host, port, access = "read", name, https, browser = false, reason }, extra) => {
      if (!ctx.lan) return text("The home network gateway isn't set up here.", true);
      // "10.0.0.1", "10.0.0.1:8443" or "https://10.0.0.1:8443/Main_Login.asp" all work; an explicit port wins.
      const addr = deviceOf(port ? `${/^https?:\/\//i.test(String(host)) ? String(host).replace(/(\/\/[^/:]+)(:\d+)?/, `$1:${port}`) : `${String(host).replace(/:\d+$/, "")}:${port}`}` : host);
      if (!addr) return text(`"${host}" isn't one device on the human's network: give its private IPv4 address and port, e.g. 192.168.1.50 and 8123.`, true);
      const tls = https ?? addr.tls;
      const wantBrowser = !!browser && !!ctx.vault;
      const { errors, target: wanted } = validateTarget({ id: "xx", host: addr.host, port: addr.port, mode: access, name: name || addr.host, tls, preset: "other" });
      if (errors.length) return text(`Can't ask for that:\n- ${errors.join("\n- ")}`, true);
      let state;
      try { state = await ctx.lan.state(); } catch (e) { return text(e.message, true); }
      const existing = state.targets.find((t) => t.host === wanted.host && t.port === wanted.port);
      const granted = { ...(state.grants?.[caller] ?? {}) };
      const inBrowser = new Set(state.browser?.[caller] ?? []);
      const now = existing && granted[existing.id] ? (granted[existing.id] === "full" && existing.mode === "full" ? "full" : "read") : null;
      if ((now === "full" || now === access) && (!wantBrowser || inBrowser.has(existing.id))) {
        return text(`You already have ${now === "full" ? "full" : "read-only"} access to ${existing.name} (${existing.host}:${existing.port})` +
          `${inBrowser.has(existing.id) ? ", from your browser too" : ""}: see network_access.`);
      }
      const label = `${wanted.host}:${wanted.port}`;
      const why = String(reason ?? "").replace(/\s+/g, " ").trim();
      const details = [
        `Device: ${wanted.name} at ${label}${wanted.tls ? " (https; its certificate isn't checked)" : ""}`,
        `Access: ${access === "full" ? "full (any method, https tunnels, ssh once you add a key)" : "read-only (GET, HEAD and OPTIONS only)"}`,
        `From: its commands${wantBrowser ? " and its browser (which opens it without asking you each time)" : " only"}`,
        `Why: ${why}`,
        `Agent: ${caller}`,
        existing ? `You already set it up as "${existing.name}".` : "You can remove it later in the agent's details (What it can reach).",
        "Its commands reach it only with `lan …`, and each command still waits for your OK unless a rule allows it.",
        "If it needs an API key or SSH key, the agent asks you for it next, here in the chat: it never sees it.",
      ].join("\n");
      let r;
      try {
        r = await ctx.askHuman({ kind: "approval", tool: LAN_TOOL, details, signal: extra?.signal,
          title: `Reach ${wanted.name} (${label}), ${access === "full" ? "full access" : "read-only"}${wantBrowser ? ", also from its browser" : ""}` });
      } catch (e) { return text(e.message, true); }
      if (r.status === "expired") return text("The human didn't answer in time. Tell them which device you need (IP and port) and why.", true);
      if (r.status !== "allowed") return text(`The human said no${r.note ? `: "${r.note}"` : ""}. Don't try to reach it another way.`, true);
      const by = r.decidedBy ?? "human";
      try {
        let target = existing;
        if (!target) {
          const base = (String(name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || `dev-${wanted.host.replace(/\./g, "-")}`);
          const taken = new Set(state.targets.map((t) => t.id));
          let id = base, n = 2;
          while (taken.has(id) || !TARGET_ID_RE.test(id)) id = `${base.slice(0, 26)}-${n++}`;
          target = { ...wanted, id, verifyTls: false, note: why.slice(0, 200) };
          await ctx.lan.saveTarget(target);
          store.event(by, "lan-target", null, { id, name: target.name, host: target.host, port: target.port, mode: target.mode, tls: target.tls, for: caller });
        } else if (access === "full" && existing.mode !== "full") {
          target = { ...existing, mode: "full" };
          await ctx.lan.saveTarget(target);
          store.event(by, "lan-target", null, { id: target.id, name: target.name, host: target.host, port: target.port, mode: "full", tls: target.tls, for: caller });
        }
        if (granted[target.id] !== "full") granted[target.id] = access;
        if (wantBrowser) inBrowser.add(target.id);
        const after = await ctx.lan.grant(caller, granted, [...inBrowser]);
        store.event(by, "lan-grant", caller, { targets: after.targets.map((t) => ({ id: t.id, mode: t.mode, browser: !!t.browser })) });
        const httpUrl = `http://${label}/`;
        return text(`Approved${r.note ? `, with a note: "${r.note}"` : ""}. You can reach ${target.name} (${label}) ${access === "full" ? "with full access" : "read-only"} ` +
          `as target "${target.id}".` +
          (wantBrowser ? ` In your browser, open ${httpUrl} (always http://${wanted.tls ? ": the gateway speaks https to it" : ""}); it may take a few seconds to restart with it.` +
            (access === "read" ? " Read-only means GET only: signing in with a form needs full access." : "") +
            " If it asks you to sign in, call request_login with that address." : "") +
          (wanted.port === 22 ? "" : ` From commands: \`lan curl -s ${httpUrl}...\` in run_command (always http://).`) +
          (access === "full" && wanted.port === 22 && !target.ssh ? ` For ssh, call request_device_key with target "${target.id}" and kind "ssh" first; then \`lan-ssh ${target.id} <command>\`.`
            : access === "full" && target.ssh ? ` ssh: \`lan-ssh ${target.id} <command>\`.`
            : wanted.port === 22 ? " ssh needs full access: ask again with access \"full\"." : "") +
          (wanted.port !== 22 && !target.credential ? " If it answers 401/403 and needs an API key or token, call request_device_key (kind \"header\"): the gateway adds it for you." : "") +
          " Each command still needs the human's OK. Check network_access if unsure.");
      } catch (e) { return text(`The human approved, but the access couldn't be set up: ${e.message}`, true); }
    },

    // Asks the human for a device's key, right in the chat: an API key or token the gateway adds to this agent's requests
    // (kind "header"), or an SSH key the gateway makes or takes (kind "ssh"). The value goes from the card straight to the
    // gateway; the agent only learns whether it's there now.
    request_device_key: async ({ target: want, kind, header, format, label, ssh_user, reason }, extra) => {
      if (!ctx.lan) return text("The home network gateway isn't set up here.", true);
      let mine;
      try { mine = await ctx.lan.forAgent(caller); } catch (e) { return text(e.message, true); }
      const t = mine.find((x) => x.id === want || `${x.host}:${x.port}` === want);
      if (!t) return text(`"${want}" isn't one of your devices: see network_access, or ask for it with request_network_access first.`, true);
      if (kind === "ssh" && t.mode !== "full") return text(`ssh needs full access to ${t.name}: ask for it with request_network_access (access "full") first.`, true);
      if (kind === "header" && !header) return text('Say which header carries it, e.g. header "Authorization" with format "Bearer {}", or "X-Api-Key" with "{}".', true);
      const why = String(reason ?? "").replace(/\s+/g, " ").trim();
      const spec = kind === "ssh" ? { target: t.id, kind, user: String(ssh_user ?? "").trim() }
        : { target: t.id, kind, header: String(header), format: String(format || "{}"), label: String(label || "API key").slice(0, 60) };
      let r;
      try {
        r = await ctx.askHuman({ kind: "approval", tool: LAN_KEY_TOOL, signal: extra?.signal, details: JSON.stringify({ ...spec, name: t.name, address: `${t.host}:${t.port}`, why }),
          title: kind === "ssh" ? `An SSH key for ${t.name} (${t.host}:${t.port})` : `The ${spec.label} of ${t.name} (${t.host}:${t.port})` });
      } catch (e) { return text(e.message, true); }
      if (r.status === "expired") return text("The human didn't answer in time. Tell them what you need the key for.", true);
      if (r.status !== "allowed") return text(`The human said no${r.note ? `: "${r.note}"` : ""}.`, true);
      let after;
      try { after = (await ctx.lan.forAgent(caller)).find((x) => x.id === t.id); } catch (e) { return text(e.message, true); }
      if (kind === "ssh") return after?.ssh ? text(`Done: the gateway signs in to ${t.name} as ${after.ssh.user}. Run \`lan-ssh ${t.id} <command>\` in run_command (one plain command per call).`)
        : text("The human answered, but no SSH key is there yet.", true);
      return after?.credential ? text(`Done: the gateway adds it to your requests to ${t.name} as ${after.credential.header}. Just retry with \`lan curl -s http://${t.host}:${t.port}/...\`.`)
        : text("The human answered, but no key is there yet.", true);
    },

    // Read-only, and only this agent's own entries. There is deliberately no tool that edits or deletes the log.
    read_log: async ({ limit = 30, before } = {}) => {
      const rows = store.logPage({ agent: caller, before: before ?? null, limit: Math.min(Math.max(limit, 1), 100) }).filter((r) => r.agent === caller);
      if (!rows.length) return text("Nothing in your log there.");
      return text(rows.map((r) => `#${r.id} ${r.at.slice(0, 19)}Z ${r.run ? `run ${r.run} ` : ""}[${r.kind}] ${r.text}`).join("\n") +
        `\n\nOlder entries: read_log with before: ${rows.at(-1).id}. The log can't be changed or deleted by you.`);
    },

    request_approval: async ({ action, details }, extra) => {
      let r;
      try { r = await ctx.askHuman({ kind: "approval", title: action, details, signal: extra?.signal }); } catch (e) { return text(e.message, true); }
      if (r.status === "allowed") return text(`Approved${r.note ? `, with a note: "${r.note}"` : ""}. Go ahead.`);
      if (r.status === "denied") return text(`The human said no${r.note ? `: "${r.note}"` : ""}. Don't do it.`);
      return text("The human didn't answer in time. Don't do it; tell them what you wanted to do so they can decide later.");
    },

    // The only way past rule zero (engine.mjs PRIVACY_RULE): the human's click on this card, for this one use.
    request_private_data: async ({ data, use }, extra) => {
      let r;
      try {
        r = await ctx.askHuman({ kind: "approval", tool: PRIVATE_TOOL, title: `Use ${data}`, details: `Private data: ${data}\nWhat for: ${use}`, signal: extra?.signal });
      } catch (e) { return text(e.message, true); }
      if (r.status === "allowed") {
        return text(`RULE ZERO OVERRIDDEN by the human for this one use only: ${data}, for: ${use}` +
          `${r.note ? ` (their note: "${r.note}")` : ""}. Use it only for that, don't save it in your notes or files, ` +
          "and don't reuse it later: any other use needs a new request_private_data.");
      }
      if (r.status === "denied") return text(`The human said no${r.note ? `: "${r.note}"` : ""}. Rule zero stands: don't use it.`);
      return text("The human didn't answer in time. Rule zero stands: don't use it; tell them what you needed it for.");
    },
  };
}

function selfTools(ctx) {
  const h = makeSelfHandlers(ctx);
  return [
    ["get_profile", "Your own profile: id, display name, description and full instructions (prompt).", {}, h.get_profile],
    ["update_profile",
      "Change your own name, description, instructions or schedule when the human asks you to. Only the fields you pass change. " +
      "Read get_profile first: prompt replaces your whole instructions, so keep what still applies.",
      {
        display_name: z.string().max(60).optional().describe('Name shown to the human, e.g. "Matias, the Market Researcher". Empty string resets it to your id.'),
        description: z.string().max(300).optional().describe("One line: what you do (shown under your name)"),
        prompt: z.string().min(20).max(LIMITS.promptMax).optional()
          .describe("Your complete new instructions/responsibilities, standalone (replaces the old ones)"),
        schedule: z.string().nullable().optional()
          .describe('When you run by yourself: 5-field cron in the server timezone (see get_profile), e.g. "0 8 * * *" for every day at 8:00. ' +
            "null or empty = on demand only. A scheduled run gets your instructions as its only message, so make sure " +
            "they say what to do on each scheduled run (update prompt in the same call if they don't)."),
        reason: z.string().max(300).optional().describe("Why, in a few words (logged)"),
      },
      h.update_profile],
    ["change_tools",
      "Change what you can use when the human asks (e.g. \"you can search the web\", \"stop writing files\"). " +
      "remove applies at once; add becomes a request the human approves with one click under your reply. See get_profile for the names.",
      {
        add: z.array(z.string()).optional().describe('Tools to get, e.g. ["WebFetch"]'),
        remove: z.array(z.string()).optional().describe(`Tools to give up, e.g. ["Write"] (not ${BASE_TOOLS.join(", ")}: every agent keeps those)`),
        reason: z.string().max(300).optional().describe("Why, in a few words (shown to the human)"),
      },
      h.change_tools],
    ...(ctx.vault ? [
      ["list_logins",
        "The site logins you may use (names only, never values) and the sites your browser can open. " +
        "Check it before signing in anywhere: you type a login's NAME into the form and the browser fills in the real value.",
        {}, h.list_logins],
      ["request_login",
        "Ask the human for a site login you need and don't have (see list_logins). They type it into a form under your reply, " +
        "straight into the vault: you only ever get the names. Ask for exactly the fields the site's sign-in form has. Then stop and tell the human.",
        {
          site: z.string().max(200).describe('The address where you sign in, e.g. "https://www.vinted.pt", or a device your browser opens, e.g. "http://192.168.1.1:8443"'),
          fields: z.array(z.object({
            name: z.string().regex(LOGIN_NAME_RE).describe('SITE_FIELD in capitals, e.g. "VINTED_EMAIL", "VINTED_PASSWORD"'),
            label: z.string().min(1).max(60).describe('What the human types, in their language, e.g. "Email", "Password"'),
            secret: z.boolean().optional().describe("true for passwords and codes: hidden while typed"),
          })).min(1).max(6).describe("One entry per field of the sign-in form"),
          reason: z.string().max(300).optional().describe("What you need it for, in a few words (shown to the human)"),
          failed: z.boolean().optional().describe("true when the site rejected the saved login, so the human types it again"),
        },
        h.request_login],
      ["request_takeover",
        "Ask the human to do something in your browser that only they can (a captcha, a code sent to them, a check you can't pass). " +
        "Leave the page where they need to act. This waits until they hand the browser back (or don't answer in time).",
        {
          reason: z.string().min(5).max(300).describe('What they need to do, in their language, e.g. "Solve the captcha on the OLX sign-in page"'),
        },
        h.request_takeover],
    ] : []),
    ["remember",
      "Save one short note to your memory: you see your notes at the start of every run, and the human can see and edit them. " +
      "For what will matter later (their preferences, facts you looked up, where you left off). Never passwords or codes.",
      { text: z.string().min(3).max(MEMORY_TEXT_MAX).describe("One fact, standalone (e.g. \"The human prefers prices in EUR\")") },
      h.remember],
    ["forget", "Remove a note from your memory (by its #id) that is no longer true or useful.",
      { id: z.number().int() }, h.forget],
    ["run_command",
      "Run one terminal command (sh). The human sees the exact command and your reason and approves it, unless a command rule " +
      "they set lets you run it without asking. Ask only for what you need and make one command do one clear thing. It runs in a " +
      "sandbox: your own folder is the working directory (files you write there stay), the internet is reachable, and it has node, curl, " +
      "jq, dig, ping, nc and ssh. Your logs, the database and logins are not there. The human's network is " +
      "unreachable except the devices they granted you: see network_access, and use them as `lan curl http://IP:PORT/...`, " +
      "or `lan-ssh <device> <command>` for one with ssh. " +
      "Returns the exit code and what it printed. Nothing keeps running after it ends.",
      {
        command: z.string().min(1).max(COMMAND_MAX).describe('The exact command line, e.g. "ls -la reports" or "lan curl -s http://192.168.1.50:8123/api/states | jq length"'),
        reason: z.string().min(5).max(300).describe("Why you need to run it, in the human's language (shown to them with the command)"),
        timeout_seconds: z.number().int().min(1).max(TIMEOUT_MAX).optional().describe(`How long it may run (default ${TIMEOUT_DEFAULT}, at most ${TIMEOUT_MAX})`),
      },
      h.run_command],
    ["network_access",
      "What you may reach on the human's home network (each device's address and whether it's read-only), how to reach it, " +
      "and which commands you may run without asking. Check it before a task that needs a device at home.",
      {}, h.network_access],
    ["request_network_access",
      "Ask the human to let you reach ONE device on their home network (one private IP and one port, e.g. a router's web UI or ssh). " +
      "They approve it in the chat; this waits for their answer. On a yes it shows up in network_access and you use it with `lan …` in run_command, " +
      "and, with browser: true, in your browser at http://IP:PORT/. " +
      "Ask read-only unless you must change something; ask once per port you need (e.g. 8443 for the web UI, 22 for ssh).",
      {
        host: z.string().max(300).describe('The device\'s private IPv4 address, or its address with a port or as a URL: "10.0.0.1", "10.0.0.1:8443", "https://10.0.0.1:8443/Main_Login.asp" (no names, no subnets)'),
        port: z.number().int().min(1).max(65535).optional().describe("The one port, e.g. 80, 443, 8443 or 22 for ssh (if host doesn't already say it)"),
        access: z.enum(["read", "full"]).optional().describe('"read" (GET/HEAD/OPTIONS only, the default) or "full" (any method, sign-in forms, https tunnels, ssh)'),
        name: z.string().max(60).optional().describe('What it is, e.g. "ASUS router"'),
        https: z.boolean().optional().describe("Whether the service speaks https (default: from the address; https:// or port 443/8443). The gateway speaks https to it, you still write http://"),
        browser: z.boolean().optional().describe("true to open it in your browser too (a web admin page), not only from commands"),
        reason: z.string().min(5).max(300).describe("Why you need it, in the human's language (shown to them)"),
      },
      h.request_network_access],
    ["request_device_key",
      "Ask the human for the key of a device you can already reach (see network_access): an API key or token (kind \"header\") that the gateway adds " +
      "to your requests, or an SSH key (kind \"ssh\", needs full access) that the gateway keeps and signs in with. They give it in the chat; this waits. " +
      "You never see the key. Use it when a device answers 401/403, or before ssh. " +
      "SSH with a password instead of a key also works: the password is a vault login whose site is that device " +
      "(e.g. http://192.168.1.1:22), granted to you. Ask for it with request_login if you have it, otherwise ask the human to add it " +
      "in the chat (key icon) and grant it to you. Then: lan-ssh -l <user> --login <NAME> <device> <command>.",
      {
        target: z.string().max(60).describe('The device: its target name from network_access, or "IP:port"'),
        kind: z.enum(["header", "ssh"]).describe('"header" for an API key or token, "ssh" for an SSH key'),
        header: z.string().max(64).optional().describe('kind header: the header that carries it, e.g. "Authorization" or "X-Api-Key"'),
        format: z.string().max(64).optional().describe('kind header: how the value goes in, "{}" for the value, e.g. "Bearer {}", or "Basic {base64}" for user:password'),
        label: z.string().max(60).optional().describe('kind header: what to ask the human for, e.g. "Long-lived access token"'),
        ssh_user: z.string().max(32).optional().describe("kind ssh: the user on the device, if you know it, e.g. admin"),
        reason: z.string().min(5).max(300).describe("Why, and where they find it (e.g. Profile → Security → Long-lived access tokens), in the human's language"),
      },
      h.request_device_key],
    ["read_log",
      "Your own log, newest first: what you were asked, the tools you used, what you said and how each run ended. " +
      "Read-only: nobody but the human can remove entries, and nothing can change them.",
      {
        limit: z.number().int().min(1).max(100).optional().describe("How many entries (default 30)"),
        before: z.number().int().optional().describe("Only entries older than this #id"),
      },
      h.read_log],
    ["request_approval",
      "Ask the human for an OK before something that can't be undone or that others will see (publish, send, buy, delete), " +
      "when they didn't explicitly ask for it. Waits for their answer: go ahead only if they approve.",
      {
        action: z.string().min(5).max(300).describe('What you want to do, in their language, e.g. "Publish the listing \\"Blue bike\\" at 80 €"'),
        details: z.string().max(3000).optional().describe("Anything they need to decide (the text you'd send, the price, the recipient...)"),
      },
      h.request_approval],
    ["request_private_data",
      "The ONLY way to override rule zero (never use private data): ask the human to let you use one piece of private data " +
      "for one purpose. Waits for their click in the app; use it only if they approve, only for that purpose, and only this once.",
      {
        data: z.string().min(3).max(300).describe('Which private data, described without revealing it, e.g. "your email address" or "your login on example.com"'),
        use: z.string().min(5).max(1000).describe("Exactly what you'd do with it and where it would go, in their language"),
      },
      h.request_private_data],
  ];
}

const instructions = (ctx) =>
  "Manage the team of agents on this server. You can look at agents, propose new ones or changes " +
  "(the human must approve), disable an agent, ask another agent for help and wait (ask_agent), " +
  "or delegate tasks that run in the background at the same time (delegate, then wait_for_tasks). " +
  `New agents inherit your model and effort (${ctx.model}, ${ctx.effort}); effort levels: ${Object.keys(EFFORTS).join(", ")}.`;

const selfInstructions = (ctx) => "Your own profile. When the human asks you to change your name, description, " +
  "responsibilities or when you run (e.g. every day at 8 am), save it with update_profile so it shows in the app " +
  "and lasts beyond this conversation. When they ask you to change what you can use, call change_tools. " +
  `You always have ${BASE_TOOLS.join(", ")}; anything else you need, request with change_tools and the human approves it. ` +
  "To run a terminal command, call run_command with the exact command and why: the human approves it before it runs (unless " +
  "one of your command rules allows it). For a device on the human's home network, call network_access first; if it isn't " +
  "there, ask for it with request_network_access (never tell the human to go grant it themselves). " +
  "Keep notes for later runs with remember and forget. Before an irreversible or public step the human didn't ask for, call request_approval." +
  (ctx.vault ? " To sign in to a website, call list_logins and type the login NAMES into the form fields: the browser fills in " +
    "the real values. Never ask for a password in the chat: if a login is missing, call request_login and stop. " +
    "For a captcha or a code only the human has, call request_takeover." : "");

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
export const createSelfServer = (ctx) => sdkServer("self", selfInstructions(ctx), selfTools(ctx));

/** Standard MCP servers, for Codex (which can't load in-process servers). Connect one to a transport. */
export const createAgentsMcpServer = (ctx) => mcpServer("agents", instructions(ctx), agentsTools(ctx));
export const createSelfMcpServer = (ctx) => mcpServer("self", selfInstructions(ctx), selfTools(ctx));
