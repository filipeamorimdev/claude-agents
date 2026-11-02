// Runs one agent: builds its sandboxed options from the database config and streams the result.
// Used by the scheduler/UI server (runner.mjs) and the CLI (cli.mjs).
// Claude models run here on the Claude Agent SDK; OpenAI models on Codex (codex.mjs, same safety model).
//
// Safety model (enforced by Claude Code, not by the prompt):
//   - each agent only gets the built-in tools listed in its `tools` (others don't exist for it)
//   - file reads/writes are fenced to the agent's own workspace folder
//   - system paths, the database, logs, uploads of other agents, Claude's home and the app are denied
//   - anything not pre-approved is refused (permissionMode "dontAsk"), never prompted
//   - the Claude process gets a minimal environment, not the container's full env
//   - MCP servers come only from the human-controlled registry (config/mcp-servers.mjs),
//     plus "self" (every agent: edit its own name, description and instructions; see agents-tool.mjs)
//
// Every run that ends sends a push notification to the verified devices (notify.mjs).

import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";
import { createAgentsServer, createSelfServer } from "./agents-tool.mjs";
import { runCodex } from "./codex.mjs";
import { notifyRun } from "./notify.mjs";
import { turnsFor, providerOf } from "./store.mjs";

const READ_TOOLS = new Set(["Read", "Glob", "Grep"]);
const WRITE_TOOLS = new Set(["Write", "Edit"]);
const STALE_RUN_MS = 2 * 60 * 60 * 1000;
const LIMIT_LABEL = { five_hour: "5h", seven_day: "weekly", seven_day_opus: "weekly Opus", seven_day_sonnet: "weekly Sonnet", overage: "extra usage" };

const CODEX_SESSION = "codex:"; // prefix of saved chat sessions that are Codex threads
const kTokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** One log line from data the stream already carried: this run's tokens and the plan limit headroom. */
function usageLine(tokens, limit, tz) {
  const parts = [`tokens: ${kTokens(tokens.input + tokens.cacheRead + tokens.cacheWrite)} in` +
    ` (${kTokens(tokens.cacheRead)} cached), ${kTokens(tokens.output)} out`];
  if (limit) {
    const label = LIMIT_LABEL[limit.rateLimitType] ?? limit.rateLimitType ?? "plan";
    const used = limit.utilization != null ? `${Math.round(limit.utilization * 100)}% used, ${Math.round((1 - limit.utilization) * 100)}% left`
      : limit.status === "rejected" ? "limit reached" : limit.status;
    const resets = limit.resetsAt ? `, resets ${new Date(limit.resetsAt * 1000).toLocaleString("en-GB", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit" })}` : "";
    parts.push(`${label} limit: ${used}${resets}`);
  }
  return parts.join(" · ");
}

export function createEngine({ store, registry, dataDir, tz, log = console.log }) {
  const pending = new Set(); // notifications being sent
  const forbidden = [
    "//proc/**", "//sys/**", "//etc/**", "//run/**", "//app/**",
    `/${dataDir}/home/**`, `/${dataDir}/logs/**`, `/${dataDir}/agents.db*`,
  ];

  function toolPolicy(agent) {
    const builtins = agent.tools.filter((t) => !t.startsWith("mcp__"));
    const mcpTools = agent.tools.filter((t) => t.startsWith("mcp__"));
    const allowed = [...mcpTools, "mcp__self"];
    for (const t of builtins) {
      if (READ_TOOLS.has(t)) continue; // reads inside the workspace need no rule
      if (WRITE_TOOLS.has(t)) allowed.push("Edit(./**)"); // writes only inside the workspace
      else allowed.push(t);
    }
    const denied = forbidden.flatMap((p) => [`Read(${p})`, `Edit(${p})`]);
    if (!builtins.includes("Bash")) denied.push("Bash");
    return { tools: builtins, allowedTools: [...new Set(allowed)], disallowedTools: denied };
  }

  function agentEnv() {
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, TZ: tz, TMPDIR: "/tmp", DISABLE_AUTOUPDATER: "1" };
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN) env.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (process.env.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    return env;
  }

  function isRunning(name) {
    const open = store.db.prepare("SELECT started_at FROM runs WHERE agent=? AND ended_at IS NULL ORDER BY id DESC LIMIT 1").get(name);
    return open && Date.now() - Date.parse(open.started_at) < STALE_RUN_MS;
  }

  async function* userMessage(textMsg, images) {
    yield {
      type: "user",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [
          ...images.map((img) => ({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } })),
          { type: "text", text: textMsg },
        ],
      },
    };
  }

  /**
   * @param name           agent name
   * @param opts.trigger   "schedule" | "manual" | "chat" | "ask:human" | "agent:<name>"
   * @param opts.message   a direct request (the agent's prompt becomes its system prompt)
   * @param opts.images    [{ mediaType, data(base64) }] sent with the message
   * @param opts.chat      continue the agent's chat conversation (resume its session)
   * @param opts.model     override (defaults to the agent's sticky model)
   * @param opts.effort    override (defaults to the agent's sticky effort)
   * @param opts.depth     0 = started by schedule/human, 1 = started by another agent
   * @param opts.onProgress ({type:"tool", name} | {type:"text", text}) => void
   * @returns {Promise<{ok: boolean, result: string, model: string, effort: string, turns?: number}>}
   */
  async function runAgent(name, opts = {}) {
    const { trigger = "manual", message = null, images = [], chat = false, depth = 0, onProgress } = opts;
    const agent = store.get(name);
    if (!agent) return { ok: false, result: `No agent "${name}".` };
    const model = opts.model ?? agent.model;
    const effort = opts.effort ?? agent.effort;
    if (!agent.enabled) return { ok: false, result: `Agent "${name}" is disabled.`, model, effort };
    const provider = providerOf(model);
    if (provider === "claude" && !process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
      return { ok: false, result: `No Claude credentials. Set CLAUDE_CODE_OAUTH_TOKEN in the stack's variables, or switch ${name} to an OpenAI model.`, model, effort };
    }
    if (isRunning(name)) {
      log(name, "already running, skipped");
      return { ok: false, busy: true, result: `${name} is busy with another task right now. Try again in a moment.`, model, effort };
    }

    const workdir = path.join(dataDir, "workspaces", name);
    const logDir = path.join(dataDir, "logs", name);
    const logFile = path.join(logDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);

    const agentsCtx = {
      store, registry, caller: name, trigger, model, effort, depth,
      askAgent: (n, m, d) => runAgent(n, { trigger: `agent:${name}`, message: m, depth: d }).then((r) => r.result),
    };
    const mcpServers = { self: createSelfServer(agentsCtx) };
    for (const t of provider === "claude" ? agent.tools.filter((t) => t.startsWith("mcp__")) : []) {
      const server = t.slice(5);
      if (server === "self") continue;
      if (server === "agents") {
        mcpServers.agents = createAgentsServer(agentsCtx);
      } else if (registry[server]) {
        mcpServers[server] = registry[server].config;
      } else {
        log(name, `MCP server "${server}" is not in config/mcp-servers.mjs, skipped`);
      }
    }

    // Recorded before the first await, so a request arriving meanwhile sees the agent as running.
    const runId = store.startRun(name, trigger);
    log(name, `starting (${trigger}, ${model}/${effort}, tools=${agent.tools.join(",") || "none"})`);
    const started = Date.now();
    let outcome = { ok: false, result: "No result.", model, effort };
    let record = { status: "error" };
    const instructions = message && `${agent.prompt}\n\n---\n` +
      `Your id is "${name}"${agent.displayName ? ` and your name is "${agent.displayName}"` : ""}. ` +
      "If the human asks you to change your name, description or responsibilities, save it with your update_profile tool. " +
      `You are being messaged directly (${trigger}). ` +
      "Answer the request in the user message, using your tools as needed. Be concise; use short markdown. " +
      "Always reply in the language the request is written in (e.g. Portuguese in, Portuguese out), " +
      "even if your instructions above are in another language.";

    const codexAttempt = async (resume) => {
      const r = await runCodex({
        agent, model, effort, prompt: message ?? agent.prompt, instructions, images, resume, maxTurns: turnsFor(effort),
        workdir, dataDir, registry, tz, agentsCtx, logFile, log, onProgress,
      });
      outcome = { ok: r.ok, result: r.result, model, effort, turns: r.turns };
      record = { status: r.status, turns: r.turns, result: r.result?.slice(0, 4000), denials: [] };
      if (chat && r.threadId) store.setSession(name, CODEX_SESSION + r.threadId);
      log(name, `${r.ok ? "done" : `ended (${r.status})`} in ${((Date.now() - started) / 1000).toFixed(0)}s, ${r.turns} tool calls`);
      log(name, usageLine(r.tokens, undefined, tz));
    };

    const claudeAttempt = async (resume) => {
      const stream = query({
        prompt: images.length ? userMessage(message ?? agent.prompt, images) : (message ?? agent.prompt),
        options: {
          cwd: workdir,
          model,
          effort,
          maxTurns: turnsFor(effort),
          ...toolPolicy(agent),
          ...(instructions ? { systemPrompt: instructions } : {}),
          ...(resume ? { resume } : {}),
          permissionMode: "dontAsk",
          mcpServers,
          settingSources: [],
          settings: { permissions: { blockReadsOutsideWorkingDirectories: true } },
          env: agentEnv(),
        },
      });
      // Per-run token totals from each API response (a response split into several messages shares one id),
      // so a resumed chat session doesn't count its earlier turns again.
      const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      const counted = new Set();
      let limit;
      for await (const msg of stream) {
        await appendFile(logFile, JSON.stringify(msg) + "\n");
        if (msg.type === "rate_limit_event") limit = msg.rate_limit_info;
        if (msg.type === "assistant" && msg.message?.usage && !counted.has(msg.message.id)) {
          counted.add(msg.message.id);
          const u = msg.message.usage;
          tokens.input += u.input_tokens ?? 0;
          tokens.output += u.output_tokens ?? 0;
          tokens.cacheRead += u.cache_read_input_tokens ?? 0;
          tokens.cacheWrite += u.cache_creation_input_tokens ?? 0;
        }
        if (msg.type === "assistant") {
          for (const block of msg.message?.content ?? []) {
            if (block.type === "tool_use") { log(name, `tool: ${block.name}`); onProgress?.({ type: "tool", name: block.name }); }
            if (block.type === "text" && block.text?.trim()) onProgress?.({ type: "text", text: block.text });
          }
        }
        if (msg.type === "result") {
          const ok = msg.subtype === "success" && !msg.is_error;
          const denials = (msg.permission_denials ?? []).map((d) => d.tool_name);
          outcome = { ok, result: msg.result || msg.errors?.join("; ") || (msg.subtype === "error_max_turns"
            ? `Stopped after ${msg.num_turns} turns (effort "${effort}" limit). Try a higher effort.` : msg.subtype),
            model, effort, turns: msg.num_turns };
          record = { status: ok ? "ok" : msg.subtype, turns: msg.num_turns, result: outcome.result?.slice(0, 4000), denials };
          if (chat && msg.session_id) store.setSession(name, msg.session_id);
          log(name, `${ok ? "done" : `ended (${msg.is_error ? "error" : msg.subtype})`} in ${((Date.now() - started) / 1000).toFixed(0)}s, ${msg.num_turns} turns`);
          if (denials.length) log(name, `refused ${denials.length} tool call(s): ${denials.join(", ")}`);
          log(name, usageLine(tokens, limit, tz));
        }
      }
    };

    try {
      await mkdir(path.join(workdir, "reports"), { recursive: true });
      await mkdir(logDir, { recursive: true });
      const attempt = provider === "claude" ? claudeAttempt : codexAttempt;
      // A conversation continues only on the provider that started it.
      const saved = chat ? store.getSession(name) : undefined;
      const sameProvider = saved && saved.startsWith(CODEX_SESSION) === (provider === "openai");
      if (saved && !sameProvider) log(name, `switched to ${provider === "claude" ? "Claude" : "OpenAI"}, starting a new conversation`);
      const resume = sameProvider ? saved.replace(CODEX_SESSION, "") : undefined;
      try {
        await attempt(resume);
      } catch (err) {
        if (!resume) throw err;
        log(name, `could not resume previous conversation (${err?.message || err}); starting a new one`);
        store.clearSession(name);
        await attempt(undefined);
      }
    } catch (err) {
      outcome = { ok: false, result: `Error: ${err?.message || err}`, model, effort };
      record = { status: "error", result: outcome.result };
      log(name, `ERROR: ${err?.message || err}`);
    } finally {
      store.endRun(runId, record);
      // Not awaited: the reply shouldn't wait for the push. The CLI waits with idle() before it exits.
      const sent = notifyRun(store, { agent: name, trigger, ...outcome, seconds: Math.round((Date.now() - started) / 1000) }, log)
        .catch((e) => log("notify", `ERROR: ${e.message}`))
        .finally(() => pending.delete(sent));
      pending.add(sent);
    }
    return outcome;
  }

  /** Resolves once the notifications already started are sent. */
  const idle = () => Promise.all([...pending]);

  return { runAgent, toolPolicy, isRunning, idle, registry };
}

/** Load a JS config module that exports `name`, falling back to the example files. */
export async function loadConfig(dir, file, exportName) {
  const example = file.endsWith(".example.mjs") ? file : file.replace(/\.mjs$/, ".example.mjs");
  const defaults = path.join(import.meta.dirname, "defaults");
  for (const f of [path.join(dir, file), path.join(dir, example), path.join(defaults, example)]) {
    try {
      const mod = await import(f);
      return mod[exportName];
    } catch (e) {
      if (e.code !== "ERR_MODULE_NOT_FOUND") throw e;
    }
  }
  return undefined;
}
