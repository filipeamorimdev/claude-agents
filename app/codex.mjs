// Runs one agent turn on Codex, for agents on an OpenAI model. Uses your ChatGPT plan
// (`codex login`, saved in DATA_DIR/home/.codex), or CODEX_API_KEY (billed per token).
// Used by engine.mjs; the Claude models stay on the Claude Agent SDK.
//
// Same safety model as the Claude path, enforced by Codex's sandbox (bubblewrap):
//   - commands run sandboxed: the agent's workspace is readable, and writable only with Write/Edit/Bash;
//     the rest of the data folder (logins, logs, database, other workspaces) and /app are hidden
//   - no network in the sandbox unless the agent has WebFetch or Bash; web search only with WebSearch
//   - no shell commands for an agent without file tools, WebFetch or Bash
//   - Codex extras (ChatGPT apps/connectors, plugins, browser/computer use, image generation) are off
//   - nothing is ever approved interactively (approval_policy "never")
//   - Codex gets a minimal environment; MCP secrets travel in env vars, not on the command line
//   - MCP servers come only from the human-controlled registry; "agents" and "self" are served on 127.0.0.1 per run
// The sandbox needs unprivileged user namespaces, so the container runs with AGENTS_SECCOMP=unconfined.

import { Codex } from "@openai/codex-sdk";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { createAgentsMcpServer, createSelfMcpServer } from "./agents-tool.mjs";
import { usesLogins, AGENT_HEADER } from "./logins.mjs";
import { agentTokens, AGENT_TOKEN_HEADER } from "./control.mjs";
const tokenOf = agentTokens(); // an agent's token for the browser's guard (control.mjs)
import { APPROVAL_MINUTES } from "./store.mjs";

// Installed outside /app (see Dockerfile): the sandbox hides /app, and Codex re-runs its own binary inside it.
const CODEX_BIN = process.env.CODEX_PATH || "/usr/local/bin/codex";
const SHELL_TOOLS = new Set(["Read", "Glob", "Grep", "Write", "Edit", "WebFetch", "Bash"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "Bash"]);
const NETWORK_TOOLS = new Set(["WebFetch", "Bash"]);
const TOOL_ITEMS = new Set(["command_execution", "mcp_tool_call", "web_search", "file_change"]);
const NO_SANDBOX = "No permissions to create a new namespace";
// Off for every agent: your ChatGPT apps/connectors, plugins, browser/computer use, image generation,
// goals and sub-agents. An agent gets only what its `tools` grant.
const FEATURES_OFF = ["apps", "plugins", "remote_plugin", "plugin_discovery_prefetch", "skill_mcp_dependency_install",
  "tool_suggest", "browser_use", "browser_use_external", "computer_use", "image_generation", "goals", "multi_agent", "hooks"];

export const LOGIN_HINT = "docker exec -it claude-agents codex login --device-auth";
export const codexHome = () => process.env.CODEX_HOME || path.join(process.env.HOME || "/tmp", ".codex");
/** Signed in with ChatGPT (auth.json from `codex login`), or an API key. */
export const codexReady = () => Boolean(process.env.CODEX_API_KEY) || existsSync(path.join(codexHome(), "auth.json"));

/** Keep Codex's login in a file (there's no keyring in the container). Run once at startup. */
export async function prepareCodexHome() {
  await mkdir(codexHome(), { recursive: true, mode: 0o700 });
  const file = path.join(codexHome(), "config.toml");
  if (!existsSync(file)) await writeFile(file, 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
}

// Codex takes `--config key=<TOML>`; the SDK's own flattening can't quote keys like "/data/home".
const toml = (v) => typeof v === "string" ? JSON.stringify(v)
  : Array.isArray(v) ? `[${v.map(toml).join(", ")}]`
  : v && typeof v === "object" ? `{ ${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)} = ${toml(x)}`).join(", ")} }`
  : String(v);

/** Sandbox profile: system files read-only, everything private hidden, the workspace per the agent's tools. */
function sandboxProfile(agent, workdir, dataDir) {
  const ls = (dir) => { try { return readdirSync(dir); } catch { return []; } };
  const filesystem = { "/app": "deny" };
  // Each sibling is denied by name: under a denied folder Codex only re-opens subfolders granted "write".
  // Denied paths must not nest (bubblewrap can't mount inside a hidden folder), hence the Codex home check.
  for (const e of ls(dataDir)) if (e !== "workspaces") filesystem[path.join(dataDir, e)] = "deny";
  if (!codexHome().startsWith(dataDir + path.sep)) filesystem[codexHome()] = "deny";
  for (const e of ls(path.join(dataDir, "workspaces"))) if (e !== agent.name) filesystem[path.join(dataDir, "workspaces", e)] = "deny";
  if (agent.tools.some((t) => WRITE_TOOLS.has(t))) Object.assign(filesystem, { [workdir]: "write", "/tmp": "write" });
  const network = agent.tools.some((t) => NETWORK_TOOLS.has(t));
  return { extends: ":read-only", filesystem, ...(network ? { network: { enabled: true, mode: "full" } } : {}) };
}

/** The agent's MCP servers in Codex's format. Header and env values are moved into `env`. */
function mcpServers(agent, registry, env, endpoints, log) {
  const servers = {};
  // The human granted these servers, so their tools run without asking (like allowedTools on the Claude path).
  const approve = { default_tools_approval_mode: "approve" };
  let n = 0;
  const viaEnv = (value) => { const k = `MCP_SECRET_${n++}`; env[k] = String(value); return k; };
  // request_approval and request_takeover wait for the human
  servers.self = { url: endpoints.self.url, bearer_token_env_var: viaEnv(endpoints.self.token), tool_timeout_sec: APPROVAL_MINUTES * 60 + 60, ...approve };
  for (const t of agent.tools.filter((t) => t.startsWith("mcp__"))) {
    const name = t.slice(5);
    const c = name === "agents" ? null : registry[name]?.config;
    if (name === "self") continue;
    if (name === "agents") {
      // ask_agent waits for the other agent's whole run
      servers.agents = { url: endpoints.agents.url, bearer_token_env_var: viaEnv(endpoints.agents.token), tool_timeout_sec: 1800, ...approve };
    } else if (!c) {
      log(agent.name, `MCP server "${name}" is not in config/mcp-servers.mjs, skipped`);
    } else if (c.url && (c.type ?? "http") === "http") {
      // A browser with vault logins learns who is calling (see engine.mjs).
      const headers = { ...c.headers, ...(usesLogins([t], registry) ? { [AGENT_HEADER]: agent.name, [AGENT_TOKEN_HEADER]: tokenOf(agent.name) } : {}) };
      servers[name] = { url: c.url, tool_timeout_sec: 300, ...approve,
        ...(Object.keys(headers).length ? { env_http_headers: Object.fromEntries(Object.entries(headers).map(([h, v]) => [h, viaEnv(v)])) } : {}) };
    } else if (c.command) {
      servers[name] = { command: c.command, args: c.args ?? [], tool_timeout_sec: 300, ...approve,
        ...(c.env ? { env_vars: Object.entries(c.env).map(([k, v]) => { env[k] = String(v); return k; }) } : {}) };
    } else {
      log(agent.name, `MCP server "${name}" (${c.type}) doesn't work with OpenAI models, skipped`);
    }
  }
  return servers;
}

// ---------- the "agents" and "self" MCP servers over local HTTP: one session per run, keyed by a bearer token ----------

let host;
function agentsHost() {
  host ??= new Promise((resolve, reject) => {
    const sessions = new Map();
    const server = createServer((req, res) => {
      const transport = sessions.get((req.headers.authorization ?? "").replace(/^Bearer /, ""));
      if (!transport) return res.writeHead(401).end();
      transport.handleRequest(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
    });
    server.once("error", reject).listen(0, "127.0.0.1", () => { server.unref(); resolve({ port: server.address().port, sessions }); });
  });
  return host;
}

async function openEndpoint(server) {
  const { port, sessions } = await agentsHost();
  const token = randomBytes(24).toString("hex");
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  await server.connect(transport);
  sessions.set(token, transport);
  return {
    url: `http://127.0.0.1:${port}/mcp`, token,
    close: async () => { sessions.delete(token); await server.close().catch(() => {}); },
  };
}

const toolName = (item) => item.type === "command_execution" ? "shell"
  : item.type === "mcp_tool_call" ? `mcp__${item.server}__${item.tool}`
  : item.type === "web_search" ? "WebSearch" : "Edit";

/** A finished Codex item as log entries: the call with its input, then how it went. */
function logItem(item, act) {
  if (!act) return;
  const tool = toolName(item);
  if (item.type === "command_execution") {
    act("tool", `Run a command: ${item.command}`, { tool, detail: item.command });
    const ok = item.status !== "failed" && !item.exit_code;
    act("result", `${ok ? "Done" : `Failed (exit ${item.exit_code ?? "?"})`} (${tool}): ${item.aggregated_output ?? ""}`, { tool, detail: item.aggregated_output ?? "", ok });
  } else if (item.type === "mcp_tool_call") {
    act("tool", `${String(item.tool).replace(/_/g, " ")} (${item.server})`, { tool, detail: item.arguments ?? null });
    const ok = item.status !== "failed" && !item.error;
    const out = item.error?.message ?? (item.result?.content ?? []).map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join("\n");
    act("result", `${ok ? "Done" : "Failed"} (${tool}): ${out}`, { tool, detail: out, ok });
  } else if (item.type === "file_change") {
    const files = (item.changes ?? []).map((c) => `${c.kind} ${c.path}`);
    act("tool", `Change files: ${files.join(", ")}`, { tool, detail: files.join("\n"), ok: item.status !== "failed" });
  } else if (item.type === "web_search") {
    act("tool", `Search the web: ${item.query ?? ""}`, { tool, detail: item.query ?? null });
  } else if (item.type === "agent_message" && item.text?.trim()) {
    act("say", item.text, { detail: item.text });
  } else if (item.type === "reasoning" && item.text?.trim()) {
    act("think", item.text, { detail: item.text });
  } else if (item.type === "error") {
    act("result", `Failed: ${item.message ?? ""}`, { detail: item.message ?? null, ok: false });
  }
}

/**
 * One turn on Codex.
 * @returns {Promise<{ok, status, result, turns, threadId, tokens}>}  throws if Codex can't start,
 *   or can't resume `resume` (the engine then starts a new conversation)
 */
export async function runCodex({ agent, model, effort, prompt, instructions, images = [], resume, maxTurns,
  workdir, dataDir, registry, tz, agentsCtx, writeLog, log, onProgress, act }) {
  if (!codexReady()) throw new Error(`ChatGPT isn't signed in. Run: ${LOGIN_HINT}`);
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, CODEX_HOME: codexHome(), TZ: tz, TMPDIR: "/tmp" };
  const endpoints = {
    self: await openEndpoint(createSelfMcpServer(agentsCtx)),
    agents: agent.tools.includes("mcp__agents") ? await openEndpoint(createAgentsMcpServer(agentsCtx)) : null,
  };
  const imageDir = images.length ? path.join(codexHome(), "images", randomUUID()) : null;
  try {
    const configOverrides = [
      'default_permissions="agent"',
      `permissions=${toml({ agent: sandboxProfile(agent, path.resolve(workdir), path.resolve(dataDir)) })}`,
      'approval_policy="never"',
      `web_search=${toml(agent.tools.includes("WebSearch") ? "live" : "disabled")}`,
      `features.shell_tool=${agent.tools.some((t) => SHELL_TOOLS.has(t))}`,
      ...FEATURES_OFF.map((f) => `features.${f}=false`),
      'shell_environment_policy.inherit="core"',
      "project_doc_max_bytes=0",
      `mcp_servers=${toml(mcpServers(agent, registry, env, endpoints, log))}`,
      ...(instructions ? [`developer_instructions=${toml(instructions)}`] : []),
    ];
    const paths = [];
    if (imageDir) {
      await mkdir(imageDir, { recursive: true });
      for (const [i, img] of images.entries()) {
        const file = path.join(imageDir, `${i}.${img.mediaType.split("/")[1] || "png"}`);
        await writeFile(file, Buffer.from(img.data, "base64"));
        paths.push(file);
      }
    }

    const codex = new Codex({ codexPathOverride: CODEX_BIN, env, configOverrides,
      ...(process.env.CODEX_API_KEY ? { apiKey: process.env.CODEX_API_KEY } : {}) });
    const options = { model, modelReasoningEffort: effort, workingDirectory: workdir, skipGitRepoCheck: true };
    const thread = resume ? codex.resumeThread(resume, options) : codex.startThread(options);
    const input = paths.length ? [{ type: "text", text: prompt }, ...paths.map((p) => ({ type: "local_image", path: p }))] : prompt;

    const abort = new AbortController();
    const { events } = await thread.runStreamed(input, { signal: abort.signal });
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const seen = new Set();
    let turns = 0, result = "", failure = null, streamError = null, completed = false, stop = null;
    try {
      for await (const ev of events) {
        writeLog?.(ev);
        const item = ev.item;
        if (item && TOOL_ITEMS.has(item.type) && !seen.has(item.id)) {
          seen.add(item.id);
          log(agent.name, `tool: ${toolName(item)}${item.type === "command_execution" ? `: ${String(item.command ?? "").slice(0, 200)}` : ""}`);
          onProgress?.({ type: "tool", name: toolName(item) });
        }
        if (ev.type === "item.completed" && item) logItem(item, act);
        if (ev.type === "item.completed" && TOOL_ITEMS.has(item.type)) {
          if (item.type === "command_execution" && item.aggregated_output?.includes(NO_SANDBOX)) {
            stop = { status: "error", result: "Codex's sandbox can't start in this container. Set AGENTS_SECCOMP=unconfined in the stack's variables and redeploy." };
          } else if (++turns >= maxTurns) {
            stop = { status: "error_max_turns", result: `Stopped after ${turns} tool calls (effort "${effort}" limit). Try a higher effort.` };
          }
          if (stop) { abort.abort(); break; }
        }
        if (ev.type === "item.completed" && item.type === "agent_message" && item.text?.trim()) {
          result = item.text;
          onProgress?.({ type: "text", text: item.text });
        }
        if (ev.type === "turn.completed") {
          completed = true;
          const u = ev.usage ?? {};
          tokens.cacheRead += u.cached_input_tokens ?? 0;
          tokens.input += Math.max(0, (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0));
          tokens.output += u.output_tokens ?? 0;
        }
        if (ev.type === "turn.failed") failure = ev.error?.message ?? "turn failed";
        if (ev.type === "error") streamError = ev.message; // can be a retry notice before the turn completes
      }
    } catch (err) {
      if (!stop) throw err;
    }
    const base = { turns, threadId: thread.id, tokens };
    if (stop) return { ...base, ok: false, ...stop };
    if (completed && !failure) return { ...base, ok: true, status: "ok", result: result || "(no reply)" };
    return { ...base, ok: false, status: "error", result: failure || streamError || "Codex ended without a reply." };
  } finally {
    await endpoints.self.close();
    await endpoints.agents?.close();
    if (imageDir) await rm(imageDir, { recursive: true, force: true });
  }
}
