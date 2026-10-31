// Agent database (SQLite, built into Node 22) + the rules every change must pass.
//
// Tables
//   agents         approved, live configuration (the only thing the runner executes)
//   proposals      changes suggested by agents, waiting for a human to approve/reject
//   runs           one row per agent run
//   events         audit log of every change and agent-to-agent interaction (mirrored to docker logs)
//   messages       chat history shown in the UI
//   chat_sessions  Claude session id per agent chat, so conversations continue
//   groups         group chats: every member agent gets each message
//
// Agents can only ever create PROPOSALS. Only a human (CLI or UI) applies them.

import { DatabaseSync } from "node:sqlite";
import cron from "node-cron";

// ---------- policy ----------

export const MODELS = ["haiku", "sonnet", "opus"];
// Effort = the SDK's reasoning effort (same levels as Claude Code) + a turn cap per run.
export const EFFORTS = { low: 10, medium: 25, high: 50, xhigh: 75, max: 100 };
export const DEFAULTS = { model: "sonnet", effort: "medium" };

export const LIMITS = {
  maxAgents: 25,
  promptMax: 8000,
  agent: { maxRunsPerHour: 4 },  // schedules an agent may propose (~every 15 min at most)
  human: { maxRunsPerHour: 60 },
};

// Built-in tools an agent may grant to another agent.
export const GRANTABLE_BUILTINS = ["Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "WebFetch"];
// Only a human can grant these.
export const HUMAN_ONLY_TOOLS = ["Bash", "mcp__agents"];
const RESERVED_NAMES = ["agents", "human", "runner", "system", "all", "team"];

const effortFromTurns = (t) => (t <= 10 ? "low" : t <= 25 ? "medium" : t <= 50 ? "high" : t <= 75 ? "xhigh" : "max");
export const turnsFor = (effort) => EFFORTS[effort] ?? EFFORTS.medium;

/**
 * Validate and normalise an agent config.
 * @param cfg      raw config (from agents.mjs, CLI, UI or an agent proposal)
 * @param actor    "human" or "agent"
 * @param registry MCP server registry (names that may be referenced)
 * @param existingTools tools the agent already has (human-only tools it already holds may stay)
 */
export function validateAgent(cfg, actor, registry = {}, existingTools = []) {
  const errors = [];
  const lim = actor === "human" ? LIMITS.human : LIMITS.agent;

  const name = String(cfg.name ?? "").trim();
  if (!/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(name)) errors.push("name: 3-32 chars, lowercase letters, digits and dashes");
  if (RESERVED_NAMES.includes(name)) errors.push(`name: "${name}" is reserved`);

  const description = String(cfg.description ?? "").trim().slice(0, 300);

  const schedule = cfg.schedule == null || cfg.schedule === "" ? null : String(cfg.schedule).trim();
  if (schedule) {
    const parts = schedule.split(/\s+/);
    if (parts.length !== 5 || !cron.validate(schedule)) {
      errors.push('schedule: must be a 5-field cron expression, e.g. "30 8 * * *" (or null for on-demand)');
    } else if (runsPerHour(parts[0]) > lim.maxRunsPerHour) {
      errors.push(`schedule: at most ${lim.maxRunsPerHour} runs per hour (minute field "${parts[0]}")`);
    }
  }

  const model = String(cfg.model ?? DEFAULTS.model);
  if (!MODELS.includes(model)) errors.push(`model: one of ${MODELS.join(", ")}`);
  const effort = String(cfg.effort ?? (cfg.maxTurns ? effortFromTurns(Number(cfg.maxTurns)) : DEFAULTS.effort));
  if (!EFFORTS[effort]) errors.push(`effort: one of ${Object.keys(EFFORTS).join(", ")}`);

  const tools = [...new Set((Array.isArray(cfg.tools) ? cfg.tools : []).map(String))];
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

// ---------- database ----------

const now = () => new Date().toISOString();

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
      decided_at TEXT
    );
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent TEXT NOT NULL, trigger TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT,
      status TEXT, turns INTEGER, result TEXT, denials TEXT
    );
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
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  // migration: effort replaces max_turns
  if (!db.prepare("PRAGMA table_info(agents)").all().some((c) => c.name === "effort")) {
    db.exec("ALTER TABLE agents ADD COLUMN effort TEXT NOT NULL DEFAULT 'medium'");
    for (const r of db.prepare("SELECT name, max_turns FROM agents").all()) {
      db.prepare("UPDATE agents SET effort=? WHERE name=?").run(effortFromTurns(r.max_turns), r.name);
    }
  }

  const row2agent = (r) => r && {
    name: r.name, description: r.description, enabled: !!r.enabled, schedule: r.schedule,
    model: r.model, effort: r.effort, maxTurns: turnsFor(r.effort), tools: JSON.parse(r.tools), prompt: r.prompt,
    createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
  };
  const row2group = (r) => r && { id: r.id, name: r.name, members: JSON.parse(r.members), createdBy: r.created_by, createdAt: r.created_at };
  const parseMsg = (m) => ({ ...m, attachments: m.attachments ? JSON.parse(m.attachments) : [], meta: m.meta ? JSON.parse(m.meta) : {} });
  const bump = () => db.prepare(
    "INSERT INTO meta(key,value) VALUES('version','1') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1"
  ).run();

  const store = {
    db,
    version: () => Number(db.prepare("SELECT value FROM meta WHERE key='version'").get()?.value ?? 0),
    getMeta: (k) => db.prepare("SELECT value FROM meta WHERE key=?").get(k)?.value,
    setMeta: (k, v) => db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, String(v)),

    /** Record an audit event (the runner mirrors these to docker logs). */
    event(actor, action, agent, details) {
      db.prepare("INSERT INTO events(at,actor,action,agent,details) VALUES (?,?,?,?,?)")
        .run(now(), actor, action, agent ?? null, details ? JSON.stringify(details) : null);
    },

    list: () => db.prepare("SELECT * FROM agents ORDER BY name").all().map(row2agent),
    get: (name) => row2agent(db.prepare("SELECT * FROM agents WHERE name=?").get(name)),
    count: () => db.prepare("SELECT COUNT(*) AS n FROM agents").get().n,

    /** Apply a validated config directly (human or approved proposal). */
    upsert(agent, actor) {
      const existing = store.get(agent.name);
      if (!existing && store.count() >= LIMITS.maxAgents) throw new Error(`limit of ${LIMITS.maxAgents} agents reached`);
      db.prepare(`
        INSERT INTO agents(name,description,enabled,schedule,model,effort,max_turns,tools,prompt,created_by,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(name) DO UPDATE SET description=excluded.description, enabled=excluded.enabled,
          schedule=excluded.schedule, model=excluded.model, effort=excluded.effort, max_turns=excluded.max_turns,
          tools=excluded.tools, prompt=excluded.prompt, updated_at=excluded.updated_at
      `).run(agent.name, agent.description, agent.enabled ? 1 : 0, agent.schedule, agent.model, agent.effort,
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
      store.event(actor, "delete", name);
      bump();
    },

    // ----- proposals -----
    propose(kind, agent, reason, proposedBy) {
      const open = db.prepare("SELECT COUNT(*) AS n FROM proposals WHERE status='open' AND proposed_by=?").get(proposedBy).n;
      if (open >= 10) throw new Error("too many open proposals from this agent; ask the human to review them first");
      const { lastInsertRowid } = db.prepare(
        "INSERT INTO proposals(kind,agent,config,reason,proposed_by,created_at) VALUES (?,?,?,?,?,?)"
      ).run(kind, agent.name, JSON.stringify(agent), reason ?? "", proposedBy, now());
      const id = Number(lastInsertRowid);
      store.event(proposedBy, `propose-${kind}`, agent.name, {
        proposal: id, reason, model: agent.model, effort: agent.effort, schedule: agent.schedule, tools: agent.tools,
      });
      bump();
      return id;
    },
    proposals: (status = "open") =>
      db.prepare("SELECT * FROM proposals WHERE (? = 'all' OR status = ?) ORDER BY id").all(status, status)
        .map((p) => ({ ...p, config: JSON.parse(p.config) })),
    /** Ids of proposals an agent made since an ISO time (to attach them to its chat reply). */
    proposalIdsSince: (by, since) =>
      db.prepare("SELECT id FROM proposals WHERE proposed_by=? AND created_at>=? ORDER BY id").all(by, since).map((r) => r.id),
    proposal: (id) => {
      const p = db.prepare("SELECT * FROM proposals WHERE id=?").get(id);
      return p && { ...p, config: JSON.parse(p.config) };
    },
    decide(id, approve, actor, registry) {
      const p = store.proposal(id);
      if (!p) throw new Error(`no proposal #${id}`);
      if (p.status !== "open") throw new Error(`proposal #${id} is already ${p.status}`);
      if (approve) {
        // Re-validate with AGENT limits: approving never widens what an agent was allowed to ask for.
        const current = store.get(p.agent);
        const { errors, agent } = validateAgent(p.config, "agent", registry, current?.tools ?? []);
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

    // ----- events -----
    events: (limit = 30) => db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(limit),
    eventsSince: (id, limit = 200) => db.prepare("SELECT * FROM events WHERE id > ? ORDER BY id LIMIT ?").all(id, limit)
      .map((e) => ({ ...e, details: e.details ? JSON.parse(e.details) : null })),
    lastEventId: () => db.prepare("SELECT COALESCE(MAX(id),0) AS id FROM events").get().id,

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

    close: () => db.close(),
  };
  return store;
}
