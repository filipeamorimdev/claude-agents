// Agent database (SQLite, built into Node 22) + the rules every change must pass.
//
// Tables
//   agents         approved, live configuration (the only thing the runner executes)
//                  display_name/description/prompt are the agent's profile, which it may edit itself (setProfile)
//   proposals      changes suggested by agents, waiting for a human to approve/reject
//   runs           one row per agent run
//   events         audit log of every change and agent-to-agent interaction (mirrored to docker logs)
//   agent_log      everything agents did: each run's request, tool calls (commands, files, pages), what the agent
//                  said and decided, results, plus a copy of every audit event. Shown on the Activity page.
//   messages       chat history shown in the UI
//   chat_sessions  Claude session id per agent chat, so conversations continue
//   groups         group chats: every member agent gets each message
//   devices        browsers/phones that get a push notification when a run ends (Web Push, notify.mjs)
//   login_requests an agent asking the human for a site login (names and labels only: values go to the vault, logins.mjs)
//   tool_rules     per agent: tools it must ask the human about before each use ("ask"), and exceptions ("allow")
//   action_requests an agent waiting mid-run for the human: a tool call to allow, an OK it asked for, or its browser to take over
//   memories       short notes an agent keeps between runs (it and the human can see and edit them)
//   triggers       webhooks that start an agent's run (only a hash of each secret URL is kept)
//   tasks          work an agent delegated to another agent, run in the background
//   command_rules  per agent: commands it may run without asking (command-rules.mjs). None by default; the human's only
//
// Agents can only ever create PROPOSALS. Only a human (CLI or UI) applies them.
// Exception: an agent may edit its own profile (name shown in the UI, description, and its instructions
// and schedule when the human asks it in a direct chat). That never changes its model or effort, and it
// can only give up tools by itself: getting a new one is always a proposal.
// Every agent always has BASE_TOOLS (read and search its own files, search the web); they can't be taken away.
//
// The logs (events, agent_log) are append-only, enforced by the database, not by a prompt: triggers refuse
// every UPDATE, and every DELETE except the human's purge (purgeLog: the CLI or the button on the Activity page).
// Nothing is ever removed automatically. Agents add entries by running, read their own (read_log), and that's all.

import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import cron from "node-cron";
import { describeEvent } from "./events.mjs";
import { validateRule, autoApproval, isReadOnly } from "./command-rules.mjs";

// ---------- policy ----------

// Claude models run on the Claude Agent SDK; the others on Codex with your ChatGPT plan (codex.mjs).
export const CLAUDE_MODELS = ["haiku", "sonnet", "opus"];
export const OPENAI_MODELS = (process.env.CODEX_MODELS ?? "gpt-6.1-sol,gpt-6-astra,gpt-6.1-terra,gpt-6-luna")
  .split(",").map((m) => m.trim()).filter(Boolean);
export const MODELS = [...CLAUDE_MODELS, ...OPENAI_MODELS];
export const providerOf = (model) => (CLAUDE_MODELS.includes(model) ? "claude" : "openai");
// Effort = the model's reasoning effort (same levels as Claude Code) + a turn cap per run.
export const EFFORTS = { low: 10, medium: 25, high: 50, xhigh: 75, max: 100 };
export const DEFAULTS = { model: MODELS.includes(process.env.DEFAULT_MODEL) ? process.env.DEFAULT_MODEL : "sonnet", effort: "medium" };

export const LIMITS = {
  maxAgents: 25,
  promptMax: 8000,
  agent: { maxRunsPerHour: 4 },  // schedules an agent may propose (~every 15 min at most)
  human: { maxRunsPerHour: 60 },
};

// Built-in tools an agent may grant to another agent.
export const GRANTABLE_BUILTINS = ["Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "WebFetch"];
// Every agent has these, whatever its config says. Anything more is granted (or approved) by the human.
export const BASE_TOOLS = ["Read", "Glob", "Grep", "WebSearch"];
export const withBase = (tools) => [...new Set([...tools, ...BASE_TOOLS])];
// Only a human can grant these.
export const HUMAN_ONLY_TOOLS = ["Bash", "mcp__agents"];
const RESERVED_NAMES = ["agents", "human", "runner", "system", "all", "team"];

const effortFromTurns = (t) => (t <= 10 ? "low" : t <= 25 ? "medium" : t <= 50 ? "high" : t <= 75 ? "xhigh" : "max");
export const turnsFor = (effort) => EFFORTS[effort] ?? EFFORTS.medium;

// ---------- "ask me first" rules ----------
// A rule names a tool the agent was granted ("Write", "Bash", "mcp__browser") or one tool of an MCP server
// ("mcp__browser__browser_click"). The most specific rule wins, so "Always allow" on one browser tool can
// sit under "ask" for the whole browser. Write and Edit are one grant (writing files), so they share rules.
export const WRITE_TOOL_NAMES = ["Write", "Edit", "MultiEdit", "NotebookEdit"];
const RULE_RE = /^(Write|Edit|Bash|WebFetch|mcp__[A-Za-z0-9_-]+)$/;
export const ruleKeyValid = (tool) => RULE_RE.test(tool) && !/^mcp__(self|agents)(__|$)/.test(tool);
/** "ask", "allow" or undefined for a tool call, given the agent's rules. */
export function ruleFor(rules, toolName) {
  const mode = (t) => rules.find((r) => r.tool === t)?.mode;
  if (WRITE_TOOL_NAMES.includes(toolName)) return mode(toolName) ?? mode("Write") ?? mode("Edit");
  const server = toolName.match(/^(mcp__[^_]+(?:_[^_]+)*?)__/)?.[1];
  return mode(toolName) ?? (server ? mode(server) : undefined);
}
export const APPROVAL_MINUTES = Number(process.env.APPROVAL_TIMEOUT_MINUTES || 30);
export const MEMORY_MAX = 50, MEMORY_TEXT_MAX = 500;
export const TASKS_OPEN_MAX = 5;
// A terminal command an agent asks to run (run_command). Each one waits for the human, unless one of the agent's
// command rules (command_rules, set by the human) auto-approves it. It isn't a tool an "ask first" rule is set for.
export const SHELL_TOOL = "Shell";
// The start of the log line of an auto-approved command
export const AUTO_APPROVED = "Auto-approved";
// What a log entry is: a run's request and end, a tool call and its result, what the agent said or thought,
// a tool call that was refused, or an audit event.
export const LOG_KINDS = ["start", "say", "think", "tool", "result", "refused", "end", "event"];
const LOG_TEXT_MAX = 500, LOG_DETAIL_MAX = 16_000;

/**
 * Validate and normalise an agent config.
 * @param cfg      raw config (from agents.mjs, CLI, UI or an agent proposal)
 * @param actor    "human" or "agent"
 * @param registry MCP server registry (names that may be referenced)
 * @param existing the agent as it is now ({ tools, schedule }): what the human already gave it may stay,
 *                 whoever asks for the change (human-only tools it holds, a schedule above the agent limit)
 */
export function validateAgent(cfg, actor, registry = {}, existing = {}) {
  const errors = [];
  const lim = actor === "human" ? LIMITS.human : LIMITS.agent;
  const existingTools = existing?.tools ?? [];

  const name = String(cfg.name ?? "").trim();
  if (!/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(name)) errors.push("name: 3-32 chars, lowercase letters, digits and dashes");
  if (RESERVED_NAMES.includes(name)) errors.push(`name: "${name}" is reserved`);

  const description = String(cfg.description ?? "").trim().slice(0, 300);

  const schedule = normSchedule(cfg.schedule);
  // Only a schedule that changes has to fit the proposer's limit: the one it already has isn't a new ask.
  errors.push(...scheduleErrors(schedule, schedule === normSchedule(existing?.schedule) ? LIMITS.human : lim));

  const model = String(cfg.model ?? DEFAULTS.model);
  if (!MODELS.includes(model)) errors.push(`model: one of ${MODELS.join(", ")}`);
  const effort = String(cfg.effort ?? (cfg.maxTurns ? effortFromTurns(Number(cfg.maxTurns)) : DEFAULTS.effort));
  if (!EFFORTS[effort]) errors.push(`effort: one of ${Object.keys(EFFORTS).join(", ")}`);

  const tools = withBase((Array.isArray(cfg.tools) ? cfg.tools : []).map(String));
  for (const t of tools) {
    if (t.startsWith("mcp__")) {
      if (t === "mcp__agents") {
        if (actor !== "human" && !existingTools.includes(t)) errors.push("tools: mcp__agents (managing agents) can only be granted by a human");
      } else if (!registry[t.slice(5)]) {
        errors.push(`tools: unknown MCP server "${t.slice(5)}" (available: ${Object.keys(registry).join(", ") || "none"})`);
      }
    } else if (HUMAN_ONLY_TOOLS.includes(t)) {
      if (actor !== "human" && !existingTools.includes(t)) errors.push(`tools: ${t} can only be granted by a human`);
    } else if (!GRANTABLE_BUILTINS.includes(t)) {
      errors.push(`tools: unknown tool "${t}" (available: ${GRANTABLE_BUILTINS.join(", ")})`);
    }
  }

  const prompt = String(cfg.prompt ?? "").trim();
  if (prompt.length < 20) errors.push("prompt: describe the agent's job (at least 20 characters)");
  if (prompt.length > LIMITS.promptMax) errors.push(`prompt: at most ${LIMITS.promptMax} characters`);

  const enabled = cfg.enabled === undefined ? true : Boolean(cfg.enabled);
  return { errors, agent: { name, description, enabled, schedule, model, effort, tools, prompt } };
}

const normSchedule = (v) => (v == null || v === "" ? null : String(v).trim());

function scheduleErrors(schedule, lim) {
  if (!schedule) return [];
  const parts = schedule.split(/\s+/);
  if (parts.length !== 5 || !cron.validate(schedule)) {
    return ['schedule: must be a 5-field cron expression, e.g. "30 8 * * *" (or null for on-demand)'];
  }
  if (runsPerHour(parts[0]) > lim.maxRunsPerHour) {
    return [`schedule: at most ${lim.maxRunsPerHour} runs per hour (minute field "${parts[0]}")`];
  }
  return [];
}

/** Validate an agent's profile edit. Only the fields passed are checked and returned. */
export function validateProfile({ displayName, description, prompt, schedule }) {
  const errors = [], profile = {};
  if (schedule !== undefined) {
    // Agent limits: an agent setting its own schedule never gets more than it could propose.
    profile.schedule = normSchedule(schedule);
    errors.push(...scheduleErrors(profile.schedule, LIMITS.agent));
  }
  if (displayName !== undefined) {
    profile.displayName = String(displayName ?? "").replace(/\s+/g, " ").trim();
    if (profile.displayName.length > 60) errors.push("display_name: at most 60 characters");
  }
  if (description !== undefined) {
    profile.description = String(description ?? "").replace(/\s+/g, " ").trim();
    if (profile.description.length > 300) errors.push("description: at most 300 characters");
  }
  if (prompt !== undefined) {
    profile.prompt = String(prompt ?? "").trim();
    if (profile.prompt.length < 20) errors.push("prompt: describe the agent's job (at least 20 characters)");
    if (profile.prompt.length > LIMITS.promptMax) errors.push(`prompt: at most ${LIMITS.promptMax} characters`);
  }
  return { errors, profile };
}

// "0" -> 1, "0,30" -> 2, "*/5" -> 12, "*" -> 60, "10-20" -> 11
function runsPerHour(minuteField) {
  let total = 0;
  for (const part of minuteField.split(",")) {
    const [range, stepStr] = part.split("/");
    const step = stepStr ? Number(stepStr) : 1;
    let lo = 0, hi = 59;
    if (range !== "*") {
      const [a, b] = range.split("-").map(Number);
      lo = a; hi = b ?? (stepStr ? 59 : a);
    }
    total += Math.floor((hi - lo) / step) + 1;
  }
  return total;
}

export function diff(before, after) {
  const out = {};
  for (const k of ["description", "enabled", "schedule", "model", "effort", "tools", "prompt"]) {
    if (JSON.stringify(before?.[k]) !== JSON.stringify(after[k])) out[k] = { from: before?.[k], to: after[k] };
  }
  return out;
}

/** What an update proposal changes: approving it later applies only this, not a stale copy of everything else. */
function changesOf(current, wanted) {
  const fields = Object.keys(diff(current, wanted));
  if (!fields.includes("tools")) return { fields };
  return { fields, tools: { add: wanted.tools.filter((t) => !current.tools.includes(t)), remove: current.tools.filter((t) => !wanted.tools.includes(t)) } };
}

/** The config that approving a proposal applies to the agent as it is now. */
function proposedConfig(current, p) {
  if (p.kind !== "update" || !current || !p.changes) return p.config; // a new agent, or a proposal from before changes were recorded
  const next = { ...current };
  for (const k of p.changes.fields) if (k !== "tools") next[k] = p.config[k];
  const t = p.changes.tools;
  if (t) next.tools = [...current.tools.filter((x) => !t.remove.includes(x)), ...t.add.filter((x) => !current.tools.includes(x))];
  return next;
}

// ---------- database ----------

const now = () => new Date().toISOString();

export const hashToken = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");

export function openStore(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS agents (
      name TEXT PRIMARY KEY,
      description TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      schedule TEXT,
      model TEXT NOT NULL,
      max_turns INTEGER NOT NULL DEFAULT 25,
      tools TEXT NOT NULL,
      prompt TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK (kind IN ('create','update')),
      agent TEXT NOT NULL,
      config TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      proposed_by TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','approved','rejected')),
      created_at TEXT NOT NULL,
      decided_at TEXT,
      changes TEXT
    );
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent TEXT NOT NULL, trigger TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT,
      status TEXT, turns INTEGER, result TEXT, denials TEXT
    );
    -- "Is it running?" is asked constantly (every chat, every UI refresh): only the open runs, not the whole history.
    CREATE INDEX IF NOT EXISTS runs_open ON runs(agent) WHERE ended_at IS NULL;
    CREATE INDEX IF NOT EXISTS runs_agent ON runs(agent, id);
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, agent TEXT, details TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('human','agent','system')),
      author TEXT NOT NULL,
      text TEXT NOT NULL,
      attachments TEXT,
      meta TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messages_chat ON messages(chat, id);
    CREATE TABLE IF NOT EXISTS chat_sessions (agent TEXT PRIMARY KEY, session_id TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      members TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS devices (
      name TEXT PRIMARY KEY,
      endpoint TEXT UNIQUE,
      p256dh TEXT,
      auth TEXT,
      platform TEXT NOT NULL DEFAULT '',
      pair_hash TEXT,
      pair_expires TEXT,
      verified_at TEXT,
      code_hash TEXT,
      code_expires TEXT,
      code_attempts INTEGER NOT NULL DEFAULT 0,
      last_sent_at TEXT,
      last_error TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS login_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent TEXT NOT NULL,
      site TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      fields TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','saved','dismissed')),
      created_at TEXT NOT NULL,
      decided_at TEXT
    );
    CREATE TABLE IF NOT EXISTS tool_rules (
      agent TEXT NOT NULL,
      tool TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('ask','allow')),
      updated_by TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (agent, tool)
    );
    CREATE TABLE IF NOT EXISTS action_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('tool','approval','takeover')),
      tool TEXT,
      title TEXT NOT NULL,
      details TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','allowed','denied','expired','done')),
      note TEXT,
      decided_by TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      decided_at TEXT
    );
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent TEXT NOT NULL,
      text TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS memories_agent ON memories(agent, id);
    CREATE TABLE IF NOT EXISTS triggers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent TEXT NOT NULL,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_at TEXT,
      count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
      result TEXT,
      reported INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT
    );
    CREATE TABLE IF NOT EXISTS command_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('exact','prefix')),
      pattern TEXT NOT NULL,
      lan TEXT NOT NULL DEFAULT 'none' CHECK (lan IN ('none','read','full')),
      note TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (agent, kind, pattern)
    );
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS agent_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      agent TEXT,
      actor TEXT,
      run INTEGER,
      kind TEXT NOT NULL,
      tool TEXT,
      text TEXT NOT NULL DEFAULT '',
      detail TEXT,
      ok INTEGER,
      event INTEGER
    );
    CREATE INDEX IF NOT EXISTS agent_log_agent ON agent_log(agent, id);
    CREATE INDEX IF NOT EXISTS agent_log_run ON agent_log(run, id);
    -- Append-only logs. purge_allowed() exists only on connections opened here and is 1 only inside purgeLog():
    -- any other connection (or code path) that tries to change or delete a log entry gets an error.
    CREATE TRIGGER IF NOT EXISTS agent_log_no_update BEFORE UPDATE ON agent_log
      BEGIN SELECT RAISE(ABORT, 'the log is append-only: entries can''t be changed'); END;
    CREATE TRIGGER IF NOT EXISTS agent_log_no_delete BEFORE DELETE ON agent_log WHEN purge_allowed() IS NOT 1
      BEGIN SELECT RAISE(ABORT, 'the log is append-only: only the human can purge it'); END;
    CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
      BEGIN SELECT RAISE(ABORT, 'the audit log is append-only: entries can''t be changed'); END;
    CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
      BEGIN SELECT RAISE(ABORT, 'the audit log is append-only: entries can''t be deleted'); END;
  `);
  let purging = false;
  db.function("purge_allowed", () => (purging ? 1 : 0));
  // migration: a display name the agent can change (the name column stays its id)
  if (!db.prepare("PRAGMA table_info(agents)").all().some((c) => c.name === "display_name")) {
    db.exec("ALTER TABLE agents ADD COLUMN display_name TEXT NOT NULL DEFAULT ''");
  }
  // migration: read-only commands run without asking (off by default; only the human turns it on)
  if (!db.prepare("PRAGMA table_info(agents)").all().some((c) => c.name === "read_only_commands")) {
    db.exec("ALTER TABLE agents ADD COLUMN read_only_commands INTEGER NOT NULL DEFAULT 0");
  }
  // migration: an update proposal records what it changes (see changesOf)
  if (!db.prepare("PRAGMA table_info(proposals)").all().some((c) => c.name === "changes")) {
    db.exec("ALTER TABLE proposals ADD COLUMN changes TEXT");
  }
  // migration: effort replaces max_turns
  if (!db.prepare("PRAGMA table_info(agents)").all().some((c) => c.name === "effort")) {
    db.exec("ALTER TABLE agents ADD COLUMN effort TEXT NOT NULL DEFAULT 'medium'");
    for (const r of db.prepare("SELECT name, max_turns FROM agents").all()) {
      db.prepare("UPDATE agents SET effort=? WHERE name=?").run(effortFromTurns(r.max_turns), r.name);
    }
  }

  // migration: every agent gets the base tools (they used to be granted one by one)
  for (const r of db.prepare("SELECT name, tools FROM agents").all()) {
    const before = JSON.parse(r.tools), after = withBase(before);
    if (after.length === before.length) continue;
    db.prepare("UPDATE agents SET tools=?, updated_at=? WHERE name=?").run(JSON.stringify(after), now(), r.name);
    db.prepare("INSERT INTO events(at,actor,action,agent,details) VALUES (?,?,?,?,?)")
      .run(now(), "system (base tools)", "update", r.name, JSON.stringify({ tools: { from: before, to: after } }));
  }

  // migration: the Activity page reads agent_log, so the audit events from before it existed are copied in once
  if (!db.prepare("SELECT 1 FROM meta WHERE key='log_backfilled'").get()) {
    if (!db.prepare("SELECT 1 FROM agent_log LIMIT 1").get()) {
      const add = db.prepare("INSERT INTO agent_log(at,agent,actor,kind,tool,text,event) VALUES (?,?,?,?,?,?,?)");
      for (const e of db.prepare("SELECT * FROM events ORDER BY id").all()) {
        add.run(e.at, e.agent, e.actor, "event", e.action, describeEvent({ ...e, details: e.details ? JSON.parse(e.details) : null }).slice(0, LOG_TEXT_MAX), e.id);
      }
    }
    db.prepare("INSERT INTO meta(key,value) VALUES('log_backfilled',?)").run(now());
  }

  const row2agent = (r) => r && {
    name: r.name, displayName: r.display_name ?? "", description: r.description, enabled: !!r.enabled, schedule: r.schedule,
    model: r.model, effort: r.effort, maxTurns: turnsFor(r.effort), tools: JSON.parse(r.tools), prompt: r.prompt,
    createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at, readOnlyCommands: !!r.read_only_commands,
  };
  const row2proposal = (p) => p && { ...p, config: JSON.parse(p.config), changes: p.changes ? JSON.parse(p.changes) : null };
  const row2group = (r) => r && { id: r.id, name: r.name, members: JSON.parse(r.members), createdBy: r.created_by, createdAt: r.created_at };
  const row2device = (r) => r && {
    name: r.name, endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth, platform: r.platform,
    pairHash: r.pair_hash, pairExpires: r.pair_expires, verifiedAt: r.verified_at,
    codeHash: r.code_hash, codeExpires: r.code_expires, codeAttempts: r.code_attempts,
    lastSentAt: r.last_sent_at, lastError: r.last_error, createdBy: r.created_by, createdAt: r.created_at,
  };
  const row2login = (r) => r && { id: r.id, agent: r.agent, site: r.site, reason: r.reason, fields: JSON.parse(r.fields), status: r.status, createdAt: r.created_at };
  const row2action = (r) => r && {
    id: r.id, agent: r.agent, kind: r.kind, tool: r.tool, title: r.title, details: r.details, status: r.status, note: r.note,
    decidedBy: r.decided_by, createdAt: r.created_at, expiresAt: r.expires_at, decidedAt: r.decided_at,
  };
  const row2trigger = (r) => r && {
    id: r.id, agent: r.agent, name: r.name, enabled: !!r.enabled, createdBy: r.created_by, createdAt: r.created_at, lastAt: r.last_at, count: r.count,
  };
  const row2task = (r) => r && {
    id: r.id, from: r.from_agent, to: r.to_agent, text: r.text, status: r.status, result: r.result, reported: !!r.reported,
    createdAt: r.created_at, startedAt: r.started_at, endedAt: r.ended_at,
  };
  const short = (s, n = 300) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  const parseMsg = (m) => ({ ...m, attachments: m.attachments ? JSON.parse(m.attachments) : [], meta: m.meta ? JSON.parse(m.meta) : {} });
  const bump = () => db.prepare(
    "INSERT INTO meta(key,value) VALUES('version','1') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1"
  ).run();

  const store = {
    db,
    version: () => Number(db.prepare("SELECT value FROM meta WHERE key='version'").get()?.value ?? 0),
    getMeta: (k) => db.prepare("SELECT value FROM meta WHERE key=?").get(k)?.value,
    setMeta: (k, v) => db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, String(v)),

    /** Record an audit event (the runner mirrors these to docker logs). A copy goes to the log the Activity page shows. */
    event(actor, action, agent, details) {
      const at = now();
      const { lastInsertRowid } = db.prepare("INSERT INTO events(at,actor,action,agent,details) VALUES (?,?,?,?,?)")
        .run(at, actor, action, agent ?? null, details ? JSON.stringify(details) : null);
      db.prepare("INSERT INTO agent_log(at,agent,actor,kind,tool,text,event) VALUES (?,?,?,?,?,?,?)")
        .run(at, agent ?? null, actor, "event", action, describeEvent({ actor, action, agent, details }).slice(0, LOG_TEXT_MAX), Number(lastInsertRowid));
    },

    // ----- the log: everything agents did. Entries are only ever added; see the triggers above. -----
    /** Add one entry. text is the line the human reads; detail the full input or output (cut when very long). */
    logAction({ agent, run = null, kind, tool = null, text = "", detail = null, ok = null }) {
      if (!LOG_KINDS.includes(kind)) throw new Error(`log kind: one of ${LOG_KINDS.join(", ")}`);
      const d = detail == null ? null : typeof detail === "string" ? detail : JSON.stringify(detail, null, 2);
      db.prepare("INSERT INTO agent_log(at,agent,actor,run,kind,tool,text,detail,ok) VALUES (?,?,?,?,?,?,?,?,?)").run(
        now(), agent, agent, run, kind, tool, short(text, LOG_TEXT_MAX),
        d && d.length > LOG_DETAIL_MAX ? `${d.slice(0, LOG_DETAIL_MAX)}\n… (${d.length - LOG_DETAIL_MAX} more characters, in the run's log file)` : d,
        ok == null ? null : ok ? 1 : 0);
    },
    /**
     * Newest first. before: entries older than this id; agent: about or by that agent; kinds: only these;
     * run: one run; q: text to find in the line or its detail.
     */
    logPage({ before = null, agent = null, kinds = null, run = null, q = null, limit = 80 } = {}) {
      const where = ["(? IS NULL OR id < ?)"], args = [before, before];
      if (agent) { where.push("(agent = ? OR actor = ? OR actor LIKE ? || ' (%')"); args.push(agent, agent, agent); }
      if (kinds?.length) { where.push(`kind IN (${kinds.map(() => "?").join(",")})`); args.push(...kinds); }
      if (run != null) { where.push("run = ?"); args.push(run); }
      if (q) { where.push("(text LIKE ? ESCAPE '\\' OR detail LIKE ? ESCAPE '\\')"); const like = `%${String(q).replace(/[\\%_]/g, "\\$&")}%`; args.push(like, like); }
      return db.prepare(`SELECT * FROM agent_log WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`).all(...args, limit);
    },
    /**
     * Interactions: one per run, newest first, with what it was asked, how it ended and what it did (counts).
     * status: "running", "ok" or "problem" (ended badly, or had a refused or failed tool call); q: text in any of its entries.
     */
    interactions({ before = null, agent = null, status = null, q = null, limit = 40 } = {}) {
      const where = ["(? IS NULL OR r.id < ?)"], args = [before, before];
      if (agent) { where.push("r.agent = ?"); args.push(agent); }
      if (status === "running") where.push("r.ended_at IS NULL");
      if (status === "ok") where.push("r.status = 'ok' AND NOT EXISTS (SELECT 1 FROM agent_log x WHERE x.run = r.id AND (x.kind = 'refused' OR (x.kind = 'result' AND x.ok = 0 AND x.tool IS NOT 'Shell')))");
      if (status === "problem") where.push("r.ended_at IS NOT NULL AND (r.status IS NOT 'ok' OR EXISTS (SELECT 1 FROM agent_log x WHERE x.run = r.id AND (x.kind = 'refused' OR (x.kind = 'result' AND x.ok = 0 AND x.tool IS NOT 'Shell'))))");
      if (q) {
        const like = `%${String(q).replace(/[\\%_]/g, "\\$&")}%`;
        where.push("(r.result LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM agent_log x WHERE x.run = r.id AND (x.text LIKE ? ESCAPE '\\' OR x.detail LIKE ? ESCAPE '\\')))");
        args.push(like, like, like);
      }
      return db.prepare(`
        SELECT r.*,
          (SELECT COALESCE(x.detail, x.text) FROM agent_log x WHERE x.run = r.id AND x.kind = 'start' ORDER BY x.id LIMIT 1) AS request,
          (SELECT x.text FROM agent_log x WHERE x.run = r.id AND x.kind = 'start' ORDER BY x.id LIMIT 1) AS start_line,
          (SELECT COUNT(*) FROM agent_log x WHERE x.run = r.id AND x.kind = 'tool') AS tools,
          (SELECT COUNT(*) FROM agent_log x WHERE x.run = r.id AND x.kind = 'refused') AS refused,
          (SELECT COUNT(*) FROM agent_log x WHERE x.run = r.id AND x.kind = 'result' AND x.ok = 0 AND x.tool IS NOT 'Shell') AS failed,
          (SELECT COUNT(*) FROM agent_log x WHERE x.run = r.id) AS entries,
          (SELECT t.from_agent FROM tasks t WHERE 'task:' || t.id = r.trigger) AS task_from
        FROM runs r WHERE ${where.join(" AND ")} ORDER BY r.id DESC LIMIT ?`).all(...args, limit);
    },
    /**
     * One interaction in full: the run, every entry it logged (with the full detail), the changes, approvals and
     * messages about its agent while it ran, the run that started it (an agent's ask or task) and the runs it started.
     */
    interaction(id) {
      const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(id);
      if (!run) return null;
      const until = run.ended_at ?? now();
      const entries = db.prepare("SELECT * FROM agent_log WHERE run = ? ORDER BY id").all(id);
      // Audit events have no run: those by or about this agent while it ran belong to it (its own "run" event is the end line).
      const events = db.prepare(`
        SELECT l.*, e.details AS event_details FROM agent_log l LEFT JOIN events e ON e.id = l.event
        WHERE l.kind = 'event' AND l.at >= ? AND l.at <= ? AND COALESCE(l.tool, '') <> 'run'
          AND (l.agent = ? OR l.actor = ? OR l.actor LIKE ? || ' (%') ORDER BY l.id`)
        .all(run.started_at, until, run.agent, run.agent, run.agent)
        .map((e) => ({ ...e, event_details: e.event_details ? JSON.parse(e.event_details) : null }));
      // Who started it: another agent asking (agent:<name>) or handing it a task (task:<id>) while that agent was running.
      let parent = null;
      const by = run.trigger.match(/^agent:(.+)$/)?.[1], task = run.trigger.match(/^task:(\d+)$/)?.[1];
      const t = task ? db.prepare("SELECT * FROM tasks WHERE id = ?").get(Number(task)) : null;
      const from = by ?? t?.from_agent, at = t?.created_at ?? run.started_at;
      if (from) parent = db.prepare("SELECT id, agent, trigger, started_at, ended_at, status FROM runs WHERE agent = ? AND started_at <= ? AND (ended_at IS NULL OR ended_at >= ?) ORDER BY id DESC LIMIT 1").get(from, at, at) ?? null;
      // What it started: agents it asked, and tasks it handed out while it ran (those may run after it ended).
      const tasks = db.prepare("SELECT * FROM tasks WHERE from_agent = ? AND created_at >= ? AND created_at <= ? ORDER BY id").all(run.agent, run.started_at, until);
      const children = db.prepare(`SELECT id, agent, trigger, started_at, ended_at, status, result FROM runs
        WHERE (trigger = ? AND started_at >= ? AND started_at <= ?) OR trigger IN (${tasks.map(() => "?").join(",") || "NULL"}) ORDER BY id`)
        .all(`agent:${run.agent}`, run.started_at, until, ...tasks.map((x) => `task:${x.id}`));
      return { run, entries, events, parent, task: t ?? null, tasks, children };
    },
    logSince: (id, limit = 500) => db.prepare("SELECT * FROM agent_log WHERE id > ? ORDER BY id LIMIT ?").all(id, limit),
    lastLogId: () => db.prepare("SELECT COALESCE(MAX(id),0) AS id FROM agent_log").get().id,
    logStats: () => db.prepare("SELECT COUNT(*) AS entries, MIN(at) AS oldest FROM agent_log").get(),
    /**
     * Delete log entries: all of them, or those older than `before` (an ISO time) and/or of one agent.
     * Only a human does this (the CLI or the Activity page): there is no agent tool for it, and the database refuses
     * a delete that doesn't come through here. The audit log keeps who purged what, and is never purged itself.
     */
    purgeLog({ before = null, agent = null, files = null } = {}, actor) {
      if (!/^human \((cli|ui)\)$/.test(String(actor))) throw new Error("only the human can purge the log");
      purging = true;
      let removed;
      try {
        removed = Number(db.prepare("DELETE FROM agent_log WHERE (? IS NULL OR at < ?) AND (? IS NULL OR agent = ?)").run(before, before, agent, agent).changes);
      } finally { purging = false; }
      store.event(actor, "log-purge", agent, { entries: removed, before, ...(files != null ? { files } : {}) });
      return removed;
    },

    list: () => db.prepare("SELECT * FROM agents ORDER BY name").all().map(row2agent),
    get: (name) => row2agent(db.prepare("SELECT * FROM agents WHERE name=?").get(name)),
    count: () => db.prepare("SELECT COUNT(*) AS n FROM agents").get().n,

    /** Apply a validated config directly (human or approved proposal). */
    upsert(agent, actor) {
      const existing = store.get(agent.name);
      if (!existing && store.count() >= LIMITS.maxAgents) throw new Error(`limit of ${LIMITS.maxAgents} agents reached`);
      db.prepare(`
        INSERT INTO agents(name,display_name,description,enabled,schedule,model,effort,max_turns,tools,prompt,created_by,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(name) DO UPDATE SET description=excluded.description, enabled=excluded.enabled,
          schedule=excluded.schedule, model=excluded.model, effort=excluded.effort, max_turns=excluded.max_turns,
          tools=excluded.tools, prompt=excluded.prompt, updated_at=excluded.updated_at
      `).run(agent.name, agent.displayName ?? "", agent.description, agent.enabled ? 1 : 0, agent.schedule, agent.model, agent.effort,
        turnsFor(agent.effort), JSON.stringify(agent.tools), agent.prompt, actor, now(), now());
      store.event(actor, existing ? "update" : "create", agent.name, existing ? diff(existing, agent) : agent);
      bump();
    },

    /** Sticky chat settings: the model/effort last used with an agent. */
    setSettings(name, { model, effort }, actor) {
      const a = store.get(name);
      if (!a) throw new Error(`no agent "${name}"`);
      const next = { model: model ?? a.model, effort: effort ?? a.effort };
      if (!MODELS.includes(next.model)) throw new Error(`model: one of ${MODELS.join(", ")}`);
      if (!EFFORTS[next.effort]) throw new Error(`effort: one of ${Object.keys(EFFORTS).join(", ")}`);
      if (next.model === a.model && next.effort === a.effort) return false;
      db.prepare("UPDATE agents SET model=?, effort=?, max_turns=?, updated_at=? WHERE name=?")
        .run(next.model, next.effort, turnsFor(next.effort), now(), name);
      store.event(actor, "settings", name, diff(a, { ...a, ...next }));
      bump();
      return true;
    },

    /** The agent's own profile edit (already validated). Returns the names of the fields that changed. */
    setProfile(name, profile, actor) {
      const a = store.get(name);
      if (!a) throw new Error(`no agent "${name}"`);
      const changes = {};
      for (const [k, v] of Object.entries(profile)) if (v !== undefined && v !== a[k]) changes[k] = { from: a[k], to: v };
      if (!Object.keys(changes).length) return [];
      const next = { ...a, ...profile };
      db.prepare("UPDATE agents SET display_name=?, description=?, prompt=?, schedule=?, updated_at=? WHERE name=?")
        .run(next.displayName, next.description, next.prompt, next.schedule, now(), name);
      store.event(actor, "update", name, changes);
      bump();
      return Object.keys(changes);
    },

    /** What an agent can use (already validated; the base tools always stay). Returns { added, removed }. */
    setTools(name, wanted, actor) {
      const a = store.get(name);
      if (!a) throw new Error(`no agent "${name}"`);
      const tools = withBase(wanted);
      const added = tools.filter((t) => !a.tools.includes(t)), removed = a.tools.filter((t) => !tools.includes(t));
      if (!added.length && !removed.length) return { added, removed };
      db.prepare("UPDATE agents SET tools=?, updated_at=? WHERE name=?").run(JSON.stringify(tools), now(), name);
      store.event(actor, "update", name, { tools: { from: a.tools, to: tools } });
      bump();
      return { added, removed };
    },

    setEnabled(name, enabled, actor) {
      const r = db.prepare("UPDATE agents SET enabled=?, updated_at=? WHERE name=?").run(enabled ? 1 : 0, now(), name);
      if (!r.changes) throw new Error(`no agent "${name}"`);
      store.event(actor, enabled ? "enable" : "disable", name);
      bump();
    },

    remove(name, actor) {
      const r = db.prepare("DELETE FROM agents WHERE name=?").run(name);
      if (!r.changes) throw new Error(`no agent "${name}"`);
      db.prepare("DELETE FROM chat_sessions WHERE agent=?").run(name);
      // What it may do and what can start it go with it; its memory stays, like its workspace files.
      db.prepare("DELETE FROM tool_rules WHERE agent=?").run(name);
      db.prepare("DELETE FROM command_rules WHERE agent=?").run(name);
      db.prepare("DELETE FROM triggers WHERE agent=?").run(name);
      store.event(actor, "delete", name);
      bump();
    },

    // ----- proposals -----
    propose(kind, agent, reason, proposedBy) {
      const open = db.prepare("SELECT COUNT(*) AS n FROM proposals WHERE status='open' AND proposed_by=?").get(proposedBy).n;
      if (open >= 10) throw new Error("too many open proposals from this agent; ask the human to review them first");
      const current = kind === "update" ? store.get(agent.name) : null;
      const { lastInsertRowid } = db.prepare(
        "INSERT INTO proposals(kind,agent,config,changes,reason,proposed_by,created_at) VALUES (?,?,?,?,?,?,?)"
      ).run(kind, agent.name, JSON.stringify(agent), current ? JSON.stringify(changesOf(current, agent)) : null, reason ?? "", proposedBy, now());
      const id = Number(lastInsertRowid);
      store.event(proposedBy, `propose-${kind}`, agent.name, {
        proposal: id, reason, model: agent.model, effort: agent.effort, schedule: agent.schedule, tools: agent.tools,
      });
      bump();
      return id;
    },
    proposals: (status = "open") =>
      db.prepare("SELECT * FROM proposals WHERE (? = 'all' OR status = ?) ORDER BY id").all(status, status).map(row2proposal),
    /** Ids of proposals an agent made since an ISO time (to attach them to its chat reply). */
    proposalIdsSince: (by, since) =>
      db.prepare("SELECT id FROM proposals WHERE proposed_by=? AND created_at>=? ORDER BY id").all(by, since).map((r) => r.id),
    proposal: (id) => row2proposal(db.prepare("SELECT * FROM proposals WHERE id=?").get(id)),
    /** The config approving a proposal would apply now: for an update, the agent as it is plus only what the proposal changes. */
    proposed: (p) => proposedConfig(store.get(p.agent), p),
    decide(id, approve, actor, registry) {
      const p = store.proposal(id);
      if (!p) throw new Error(`no proposal #${id}`);
      if (p.status !== "open") throw new Error(`proposal #${id} is already ${p.status}`);
      if (approve) {
        // Re-validate with AGENT limits: approving never widens what an agent was allowed to ask for.
        // Only what the proposal changes is applied, so settings changed since it was made stay as they are.
        const current = store.get(p.agent);
        const { errors, agent } = validateAgent(proposedConfig(current, p), "agent", registry, current ?? {});
        if (errors.length) throw new Error(`proposal no longer valid: ${errors.join("; ")}`);
        if (p.kind === "create" && current) throw new Error(`agent "${agent.name}" already exists`);
        if (p.kind === "update" && !current) throw new Error(`agent "${agent.name}" no longer exists`);
        store.upsert(agent, `${actor} (approved #${id} from ${p.proposed_by})`);
      }
      db.prepare("UPDATE proposals SET status=?, decided_at=? WHERE id=?").run(approve ? "approved" : "rejected", now(), id);
      store.event(actor, approve ? "approve" : "reject", p.agent, { proposal: id, proposed_by: p.proposed_by });
      bump();
      return p;
    },

    // ----- runs -----
    startRun(agent, trigger) {
      return Number(db.prepare("INSERT INTO runs(agent,trigger,started_at) VALUES (?,?,?)").run(agent, trigger, now()).lastInsertRowid);
    },
    endRun(id, { status, turns, result, denials }) {
      db.prepare("UPDATE runs SET ended_at=?, status=?, turns=?, result=?, denials=? WHERE id=?")
        .run(now(), status, turns ?? null, result ?? null, denials ? JSON.stringify(denials) : null, id);
    },
    runs: (agent, limit = 20) => agent
      ? db.prepare("SELECT * FROM runs WHERE agent=? ORDER BY id DESC LIMIT ?").all(agent, limit)
      : db.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT ?").all(limit),
    runningAgents: () => db.prepare(
      "SELECT DISTINCT agent FROM runs WHERE ended_at IS NULL AND started_at > ?"
    ).all(new Date(Date.now() - 2 * 3600e3).toISOString()).map((r) => r.agent),
    /** Runs left open by a process that stopped (crash, redeploy): they'd keep their agent "busy" for hours. Returns them. */
    closeStaleRuns() {
      const open = db.prepare("SELECT id, agent, trigger FROM runs WHERE ended_at IS NULL ORDER BY id").all();
      for (const r of open) {
        store.endRun(r.id, { status: "interrupted", result: "The server restarted before this run finished." });
        store.event("system", "run", r.agent, { run: r.id, trigger: r.trigger, status: "interrupted", turns: null });
      }
      return open;
    },

    // ----- events -----
    events: (limit = 30) => db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(limit),
    eventsSince: (id, limit = 200) => db.prepare("SELECT * FROM events WHERE id > ? ORDER BY id LIMIT ?").all(id, limit)
      .map((e) => ({ ...e, details: e.details ? JSON.parse(e.details) : null })),
    lastEventId: () => db.prepare("SELECT COALESCE(MAX(id),0) AS id FROM events").get().id,
    /** The audit log, newest first, for the Activity view: older than `before`, about or by one agent. */
    eventsPage: ({ before = null, agent = null, limit = 50 } = {}) => db.prepare(
      "SELECT * FROM events WHERE (? IS NULL OR id < ?) AND (? IS NULL OR agent = ? OR actor = ? OR actor LIKE ? || ' (%') ORDER BY id DESC LIMIT ?"
    ).all(before, before, agent, agent, agent, agent, limit).map((e) => ({ ...e, details: e.details ? JSON.parse(e.details) : null })),

    // ----- chat -----
    addMessage(chat, role, author, text, { attachments, meta } = {}) {
      const { lastInsertRowid } = db.prepare(
        "INSERT INTO messages(chat,role,author,text,attachments,meta,created_at) VALUES (?,?,?,?,?,?,?)"
      ).run(chat, role, author, text, attachments?.length ? JSON.stringify(attachments) : null, meta ? JSON.stringify(meta) : null, now());
      return store.message(Number(lastInsertRowid));
    },
    message: (id) => { const m = db.prepare("SELECT * FROM messages WHERE id=?").get(id); return m && parseMsg(m); },
    messages: (chat, before = null, limit = 60) =>
      db.prepare("SELECT * FROM messages WHERE chat=? AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?")
        .all(chat, before, before, limit).reverse().map(parseMsg),
    lastMessages: () => db.prepare(
      "SELECT m.* FROM messages m JOIN (SELECT chat, MAX(id) AS id FROM messages GROUP BY chat) x ON x.id = m.id"
    ).all().map(parseMsg),
    getSession: (agent) => db.prepare("SELECT session_id FROM chat_sessions WHERE agent=?").get(agent)?.session_id,
    setSession: (agent, sid) => db.prepare(
      "INSERT INTO chat_sessions(agent,session_id,updated_at) VALUES (?,?,?) ON CONFLICT(agent) DO UPDATE SET session_id=excluded.session_id, updated_at=excluded.updated_at"
    ).run(agent, sid, now()),
    clearSession: (agent) => db.prepare("DELETE FROM chat_sessions WHERE agent=?").run(agent),

    // ----- groups: chats where every member agent gets each message (chat key "group:<id>") -----
    groups: () => db.prepare("SELECT * FROM groups ORDER BY name").all().map(row2group),
    group: (id) => row2group(db.prepare("SELECT * FROM groups WHERE id=?").get(id)),
    createGroup(name, members, actor) {
      const { lastInsertRowid } = db.prepare("INSERT INTO groups(name,members,created_by,created_at,updated_at) VALUES (?,?,?,?,?)")
        .run(name, JSON.stringify(members), actor, now(), now());
      const id = Number(lastInsertRowid);
      store.event(actor, "group-create", null, { group: id, name, members });
      return store.group(id);
    },
    updateGroup(id, { name, members }, actor) {
      const g = store.group(id);
      if (!g) throw new Error(`no group #${id}`);
      db.prepare("UPDATE groups SET name=?, members=?, updated_at=? WHERE id=?").run(name, JSON.stringify(members), now(), id);
      store.event(actor, "group-update", null, {
        group: id, name, ...(g.name !== name ? { renamed: g.name } : {}),
        added: members.filter((m) => !g.members.includes(m)), removed: g.members.filter((m) => !members.includes(m)),
      });
      return store.group(id);
    },
    deleteGroup(id, actor) {
      const g = store.group(id);
      if (!g) throw new Error(`no group #${id}`);
      db.prepare("DELETE FROM groups WHERE id=?").run(id);
      db.prepare("DELETE FROM messages WHERE chat=?").run(`group:${id}`);
      store.event(actor, "group-delete", null, { group: id, name: g.name });
    },

    // ----- devices: get a push notification when a run ends (rules and sending in notify.mjs) -----
    devices: () => db.prepare("SELECT * FROM devices ORDER BY name").all().map(row2device),
    device: (name) => row2device(db.prepare("SELECT * FROM devices WHERE name=?").get(name)),
    /** A device waiting for its browser: either connected right away (UI) or later with a pairing code (CLI). */
    addDevice({ name, pairHash = null, pairExpires = null }, actor) {
      if (store.device(name)) throw new Error(`there is already a device called "${name}"`);
      db.prepare("INSERT INTO devices(name,pair_hash,pair_expires,created_by,created_at) VALUES (?,?,?,?,?)")
        .run(name, pairHash, pairExpires, actor, now());
      store.event(actor, "device-add", null, { device: name, pairing: !!pairHash });
    },
    /** A browser's push subscription for a device. It needs confirming again. Never logged: it's a secret. */
    connectDevice(name, { endpoint, p256dh, auth, platform }, actor) {
      db.prepare(`UPDATE devices SET endpoint=?, p256dh=?, auth=?, platform=?, pair_hash=NULL, pair_expires=NULL,
        verified_at=NULL, code_hash=NULL, code_expires=NULL, code_attempts=0, last_error=NULL WHERE name=?`).run(endpoint, p256dh, auth, platform, name);
      store.event(actor, "device-connect", null, { device: name, platform });
    },
    /** The browser renewed its subscription (same device, still confirmed). */
    renewDevice: (oldEndpoint, { endpoint, p256dh, auth }) =>
      db.prepare("UPDATE devices SET endpoint=?, p256dh=?, auth=?, last_error=NULL WHERE endpoint=?").run(endpoint, p256dh, auth, oldEndpoint).changes > 0,
    /** The push service says the subscription is gone (notifications turned off, browser data cleared). */
    disconnectDevice(name) {
      db.prepare("UPDATE devices SET endpoint=NULL, p256dh=NULL, auth=NULL, verified_at=NULL, code_hash=NULL WHERE name=?").run(name);
      store.event("system", "device-disconnect", null, { device: name });
    },
    removeDevice(name, actor) {
      if (!db.prepare("DELETE FROM devices WHERE name=?").run(name).changes) throw new Error(`no device "${name}"`);
      store.event(actor, "device-remove", null, { device: name });
    },
    setDeviceCode: (name, codeHash, expires) =>
      db.prepare("UPDATE devices SET code_hash=?, code_expires=?, code_attempts=0 WHERE name=?").run(codeHash, expires, name),
    failDeviceCode: (name) => db.prepare("UPDATE devices SET code_attempts=code_attempts+1 WHERE name=?").run(name),
    verifyDevice(name, actor) {
      db.prepare("UPDATE devices SET verified_at=?, code_hash=NULL, code_expires=NULL, code_attempts=0 WHERE name=?").run(now(), name);
      store.event(actor, "device-verify", null, { device: name });
    },
    deviceSent: (name, error) => db.prepare("UPDATE devices SET last_sent_at=?, last_error=? WHERE name=?").run(now(), error, name),

    // ----- login requests: an agent asks for a site login; the human types it into the vault (never stored here) -----
    /** fields: [{ name, label, secret }]. Replaces the agent's open request for the same site. */
    requestLogin(agent, { site, reason, fields }) {
      const open = db.prepare("SELECT COUNT(*) AS n FROM login_requests WHERE status='open' AND agent=? AND site<>?").get(agent, site).n;
      if (open >= 5) throw new Error("too many open login requests from this agent; ask the human to answer them first");
      db.prepare("UPDATE login_requests SET status='dismissed', decided_at=? WHERE status='open' AND agent=? AND site=?").run(now(), agent, site);
      const { lastInsertRowid } = db.prepare("INSERT INTO login_requests(agent,site,reason,fields,created_at) VALUES (?,?,?,?,?)")
        .run(agent, site, reason ?? "", JSON.stringify(fields), now());
      const id = Number(lastInsertRowid);
      store.event(agent, "login-request", agent, { request: id, site, names: fields.map((f) => f.name), reason });
      return id;
    },
    loginRequest: (id) => row2login(db.prepare("SELECT * FROM login_requests WHERE id=?").get(id)),
    /** Ids of login requests an agent made since an ISO time (to attach them to its reply). */
    loginRequestIdsSince: (agent, since) =>
      db.prepare("SELECT id FROM login_requests WHERE agent=? AND created_at>=? ORDER BY id").all(agent, since).map((r) => r.id),
    closeLoginRequest(id, status, actor, names = []) {
      const r = store.loginRequest(id);
      if (!r) throw new Error(`no login request #${id}`);
      if (r.status !== "open") throw new Error(`that login request is already ${r.status}`);
      db.prepare("UPDATE login_requests SET status=?, decided_at=? WHERE id=?").run(status, now(), id);
      store.event(actor, status === "saved" ? "login-save" : "login-dismiss", r.agent, { request: id, site: r.site, names });
      return r;
    },

    // ----- "ask me first" rules: which tool calls wait for the human (engine.mjs) -----
    rules: (agent) => db.prepare("SELECT tool, mode FROM tool_rules WHERE agent=? ORDER BY tool").all(agent),
    /** mode "ask" | "allow", or null to drop the rule. */
    setRule(agent, tool, mode, actor) {
      if (!store.get(agent)) throw new Error(`no agent "${agent}"`);
      if (!ruleKeyValid(tool)) throw new Error(`can't set a rule for "${tool}"`);
      const before = db.prepare("SELECT mode FROM tool_rules WHERE agent=? AND tool=?").get(agent, tool)?.mode ?? null;
      if (before === (mode ?? null)) return false;
      if (mode) {
        if (!["ask", "allow"].includes(mode)) throw new Error('mode: "ask" or "allow"');
        db.prepare(`INSERT INTO tool_rules(agent,tool,mode,updated_by,updated_at) VALUES (?,?,?,?,?)
          ON CONFLICT(agent,tool) DO UPDATE SET mode=excluded.mode, updated_by=excluded.updated_by, updated_at=excluded.updated_at`).run(agent, tool, mode, actor, now());
      } else db.prepare("DELETE FROM tool_rules WHERE agent=? AND tool=?").run(agent, tool);
      store.event(actor, "rule", agent, { tool, from: before, to: mode ?? null });
      return true;
    },

    // ----- command rules: commands an agent may run without asking (command-rules.mjs). Only the human sets them. -----
    commandRules: (agent) => db.prepare("SELECT id, kind, pattern, lan, note, created_by, created_at FROM command_rules WHERE agent=? ORDER BY id").all(agent),
    addCommandRule(agent, input, actor) {
      if (!/^human \(/.test(String(actor))) throw new Error("only the human sets which commands run without asking");
      if (!store.get(agent)) throw new Error(`no agent "${agent}"`);
      const { errors, rule } = validateRule(input);
      if (errors.length) throw new Error(errors.join("; "));
      const same = db.prepare("SELECT id FROM command_rules WHERE agent=? AND kind=? AND pattern=?").get(agent, rule.kind, rule.pattern);
      if (same) {
        db.prepare("UPDATE command_rules SET lan=?, note=? WHERE id=?").run(rule.lan, rule.note, same.id);
        store.event(actor, "command-rule", agent, { rule: same.id, ...rule, changed: true });
        return same.id;
      }
      const { lastInsertRowid } = db.prepare("INSERT INTO command_rules(agent,kind,pattern,lan,note,created_by,created_at) VALUES (?,?,?,?,?,?,?)")
        .run(agent, rule.kind, rule.pattern, rule.lan, rule.note, actor, now());
      const id = Number(lastInsertRowid);
      store.event(actor, "command-rule", agent, { rule: id, ...rule });
      return id;
    },
    /** Read-only commands (command-rules.mjs isReadOnly) run without asking. Only the human switches it. */
    setReadOnlyCommands(agent, on, actor) {
      if (!/^human \(/.test(String(actor))) throw new Error("only the human sets which commands run without asking");
      if (!store.get(agent)) throw new Error(`no agent "${agent}"`);
      db.prepare("UPDATE agents SET read_only_commands=? WHERE name=?").run(on ? 1 : 0, agent);
      store.event(actor, "read-only-commands", agent, { on: !!on });
    },
    removeCommandRule(id, actor) {
      const r = db.prepare("SELECT * FROM command_rules WHERE id=?").get(id);
      if (!r) throw new Error(`no rule #${id}`);
      db.prepare("DELETE FROM command_rules WHERE id=?").run(id);
      store.event(actor, "command-rule-remove", r.agent, { rule: id, kind: r.kind, pattern: r.pattern });
      return r;
    },
    /**
     * Whether an agent's command runs without asking: { rules: [{ id, kind, pattern, lan }], lan } or null.
     * With read-only commands on, a command that only reads in its own folder runs too: { rules: [], lan: "none",
     * readOnly: true }.
     */
    autoApprove(agent, cmd) {
      const rules = store.commandRules(agent);
      const r = autoApproval(rules, cmd);
      if (!r) return store.get(agent)?.readOnlyCommands && isReadOnly(cmd, agent) ? { rules: [], lan: "none", readOnly: true } : null;
      return { rules: rules.filter((x) => r.rules.includes(x.id)), lan: r.lan };
    },

    // ----- action requests: an agent waiting mid-run for the human's answer -----
    requestAction(agent, { kind, tool = null, title, details = null, minutes = APPROVAL_MINUTES }) {
      const open = db.prepare("SELECT COUNT(*) AS n FROM action_requests WHERE status='open' AND agent=?").get(agent).n;
      if (open >= 5) throw new Error("too many requests waiting for the human already");
      const expires = new Date(Date.now() + minutes * 60e3).toISOString();
      const { lastInsertRowid } = db.prepare("INSERT INTO action_requests(agent,kind,tool,title,details,created_at,expires_at) VALUES (?,?,?,?,?,?,?)")
        .run(agent, kind, tool, short(title, 300), details ? String(details).slice(0, 4000) : null, now(), expires);
      const id = Number(lastInsertRowid);
      store.event(agent, "action-request", agent, { request: id, kind, tool, title: short(title, 200) });
      return id;
    },
    action: (id) => row2action(db.prepare("SELECT * FROM action_requests WHERE id=?").get(id)),
    openActions: () => db.prepare("SELECT * FROM action_requests WHERE status='open' ORDER BY id").all().map(row2action),
    /** status: allowed | denied | done (takeover finished) | expired. Only an open request can be answered. */
    decideAction(id, status, actor, note = "") {
      const r = store.action(id);
      if (!r) throw new Error(`no request #${id}`);
      if (r.status !== "open") throw new Error(`that request is already ${r.status}`);
      db.prepare("UPDATE action_requests SET status=?, note=?, decided_by=?, decided_at=? WHERE id=? AND status='open'")
        .run(status, short(note, 1000) || null, actor, now(), id);
      store.event(actor, `action-${status}`, r.agent, { request: id, kind: r.kind, tool: r.tool, title: short(r.title, 200), ...(note ? { note: short(note, 300) } : {}) });
      return store.action(id);
    },

    // ----- memory: notes an agent keeps between runs (shown to it on every run) -----
    memories: (agent) => db.prepare("SELECT id, text, created_by, created_at, updated_at FROM memories WHERE agent=? ORDER BY id").all(agent),
    memory: (id) => db.prepare("SELECT * FROM memories WHERE id=?").get(id),
    addMemory(agent, text, actor) {
      const t = String(text ?? "").replace(/\s+/g, " ").trim();
      if (!t) throw new Error("the note is empty");
      if (t.length > MEMORY_TEXT_MAX) throw new Error(`a note is at most ${MEMORY_TEXT_MAX} characters: keep one fact per note`);
      if (db.prepare("SELECT COUNT(*) AS n FROM memories WHERE agent=?").get(agent).n >= MEMORY_MAX) {
        throw new Error(`memory is full (${MEMORY_MAX} notes): forget notes that are no longer useful first`);
      }
      const { lastInsertRowid } = db.prepare("INSERT INTO memories(agent,text,created_by,created_at,updated_at) VALUES (?,?,?,?,?)").run(agent, t, actor, now(), now());
      const id = Number(lastInsertRowid);
      store.event(actor, "memory-add", agent, { memory: id, text: short(t, 200) });
      return id;
    },
    editMemory(id, text, actor) {
      const m = store.memory(id), t = String(text ?? "").replace(/\s+/g, " ").trim();
      if (!m) throw new Error(`no note #${id}`);
      if (!t) throw new Error("the note is empty");
      if (t.length > MEMORY_TEXT_MAX) throw new Error(`a note is at most ${MEMORY_TEXT_MAX} characters`);
      db.prepare("UPDATE memories SET text=?, updated_at=? WHERE id=?").run(t, now(), id);
      store.event(actor, "memory-edit", m.agent, { memory: id, from: short(m.text, 200), text: short(t, 200) });
    },
    deleteMemory(id, actor) {
      const m = store.memory(id);
      if (!m) throw new Error(`no note #${id}`);
      db.prepare("DELETE FROM memories WHERE id=?").run(id);
      store.event(actor, "memory-delete", m.agent, { memory: id, text: short(m.text, 200) });
      return m;
    },

    // ----- triggers: webhooks that start a run (the secret URL is shown once; only its hash is kept) -----
    triggers: (agent) => db.prepare("SELECT * FROM triggers WHERE agent=? ORDER BY id").all(agent).map(row2trigger),
    trigger: (id) => row2trigger(db.prepare("SELECT * FROM triggers WHERE id=?").get(id)),
    triggerByHash: (hash) => row2trigger(db.prepare("SELECT * FROM triggers WHERE token_hash=?").get(hash)),
    addTrigger(agent, name, tokenHash, actor) {
      if (db.prepare("SELECT COUNT(*) AS n FROM triggers WHERE agent=?").get(agent).n >= 10) throw new Error("at most 10 webhooks per agent");
      const { lastInsertRowid } = db.prepare("INSERT INTO triggers(agent,name,token_hash,created_by,created_at) VALUES (?,?,?,?,?)")
        .run(agent, name, tokenHash, actor, now());
      const id = Number(lastInsertRowid);
      store.event(actor, "trigger-add", agent, { trigger: id, name });
      return id;
    },
    setTriggerEnabled(id, enabled, actor) {
      const t = store.trigger(id);
      if (!t) throw new Error(`no webhook #${id}`);
      db.prepare("UPDATE triggers SET enabled=? WHERE id=?").run(enabled ? 1 : 0, id);
      store.event(actor, enabled ? "trigger-enable" : "trigger-disable", t.agent, { trigger: id, name: t.name });
    },
    removeTrigger(id, actor) {
      const t = store.trigger(id);
      if (!t) throw new Error(`no webhook #${id}`);
      db.prepare("DELETE FROM triggers WHERE id=?").run(id);
      store.event(actor, "trigger-remove", t.agent, { trigger: id, name: t.name });
    },
    fireTrigger(id, info) {
      const t = store.trigger(id);
      db.prepare("UPDATE triggers SET last_at=?, count=count+1 WHERE id=?").run(now(), id);
      store.event(`webhook "${t.name}"`, "trigger-fire", t.agent, { trigger: id, name: t.name, ...info });
    },

    // ----- tasks: one agent delegating work to another, run in the background (tasks.mjs) -----
    createTask(from, to, text) {
      const open = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE from_agent=? AND status IN ('queued','running')").get(from).n;
      if (open >= TASKS_OPEN_MAX) throw new Error(`you already have ${open} tasks in progress: wait for them first (wait_for_tasks)`);
      const { lastInsertRowid } = db.prepare("INSERT INTO tasks(from_agent,to_agent,text,created_at) VALUES (?,?,?,?)").run(from, to, text, now());
      const id = Number(lastInsertRowid);
      store.event(from, "task-create", to, { task: id, text: short(text, 300) });
      return id;
    },
    task: (id) => row2task(db.prepare("SELECT * FROM tasks WHERE id=?").get(id)),
    tasksFrom: (from, ids = null) => db.prepare("SELECT * FROM tasks WHERE from_agent=? ORDER BY id DESC LIMIT 20").all(from)
      .map(row2task).filter((t) => !ids || ids.includes(t.id)),
    /** Ids of tasks an agent delegated since an ISO time (to attach them to its reply). */
    taskIdsSince: (from, since) =>
      db.prepare("SELECT id FROM tasks WHERE from_agent=? AND created_at>=? ORDER BY id").all(from, since).map((r) => r.id),
    startTask(id) {
      db.prepare("UPDATE tasks SET status='running', started_at=? WHERE id=?").run(now(), id);
      const t = store.task(id);
      store.event(t.to, "task-start", t.from, { task: id });
    },
    endTask(id, ok, result) {
      db.prepare("UPDATE tasks SET status=?, result=?, ended_at=? WHERE id=?").run(ok ? "done" : "failed", String(result ?? "").slice(0, 8000), now(), id);
      const t = store.task(id);
      store.event(t.to, ok ? "task-done" : "task-fail", t.from, { task: id, result: short(result, 300) });
      return t;
    },
    markTasksReported: (ids) => { for (const id of ids) db.prepare("UPDATE tasks SET reported=1 WHERE id=?").run(id); },
    /** Finished tasks the delegator hasn't seen yet, and whether any of its tasks are still going. */
    unreportedTasks: (from) => ({
      finished: db.prepare("SELECT * FROM tasks WHERE from_agent=? AND status IN ('done','failed') AND reported=0 ORDER BY id").all(from).map(row2task),
      pending: db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE from_agent=? AND status IN ('queued','running')").get(from).n,
    }),
    /** Tasks left queued or running by a process that stopped (restart): they won't finish. */
    failStaleTasks() {
      for (const r of db.prepare("SELECT id FROM tasks WHERE status IN ('queued','running')").all()) {
        store.endTask(r.id, false, "The server restarted before this task finished.");
      }
      db.prepare("UPDATE action_requests SET status='expired', decided_at=? WHERE status='open'").run(now());
    },

    close: () => db.close(),
  };
  return store;
}
