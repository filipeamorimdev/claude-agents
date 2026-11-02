// Main process: scheduler + chat UI + audit log mirror.
//  - keeps cron jobs in sync with the agents table (changes apply within ~10 s, no restart)
//  - mirrors every audit event (new agents, proposals, approvals, agent-to-agent messages)
//    to stdout, so they show in `docker logs claude-agents`, whoever made them (UI, CLI, agents)
//  - serves the chat UI when UI_PASSWORD is set (over https with config/tls/cert.pem + key.pem)

import cron from "node-cron";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { openStore, validateAgent } from "./store.mjs";
import { createEngine, loadConfig } from "./engine.mjs";
import { describeEvent } from "./events.mjs";
import { startUi } from "./ui-server.mjs";
import { prepareCodexHome, codexReady, LOGIN_HINT } from "./codex.mjs";

const DATA_DIR = process.env.DATA_DIR || "/data";
const CONFIG_DIR = process.env.CONFIG_DIR || "/app/config";
const TZ = process.env.TZ || "UTC";
const UI_PORT = Number(process.env.UI_PORT || 8090);
const log = (name, msg) => console.log(`${new Date().toISOString()} [${name}] ${msg}`);

// Keeps running without credentials, so you can still sign in with ChatGPT inside the container.
await prepareCodexHome();
if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY && !codexReady()) {
  console.error("No credentials yet: set CLAUDE_CODE_OAUTH_TOKEN (or ANTHROPIC_API_KEY) in the stack's variables, " +
    `or sign in with ChatGPT: ${LOGIN_HINT}`);
}

const store = openStore(path.join(DATA_DIR, "agents.db"));
const registry = (await loadConfig(CONFIG_DIR, "mcp-servers.mjs", "mcpServers")) ?? {};
const engine = createEngine({ store, registry, dataDir: DATA_DIR, tz: TZ, log });
const bus = new EventEmitter();

// Backwards compatible: node runner.mjs --run NAME
const runIdx = process.argv.indexOf("--run");
if (runIdx !== -1) {
  const r = await engine.runAgent(process.argv[runIdx + 1], { trigger: "manual" });
  console.log(r.result);
  await engine.idle();
  process.exit(r.ok ? 0 : 1);
}

// ---------- audit log -> docker logs (+ UI) ----------
let lastEvent = store.lastEventId();
function tailEvents() {
  for (const e of store.eventsSince(lastEvent)) {
    lastEvent = e.id;
    console.log(`${e.at} [event] ${describeEvent(e)}`);
    bus.emit("event", e);
  }
}

// First start: import config/agents.mjs into the database (as the human).
if (!store.getMeta("seeded")) {
  const seed = (await loadConfig(CONFIG_DIR, "agents.mjs", "agents")) ?? [];
  for (const cfg of seed) {
    const { errors, agent } = validateAgent(cfg, "human", registry);
    if (errors.length) log("seed", `skipped "${cfg.name}": ${errors.join("; ")}`);
    else store.upsert(agent, "human (initial import)");
  }
  store.setMeta("seeded", new Date().toISOString());
  lastEvent = 0; // show the imports in the log
}
// Creating agents from the chat relies on agent-architect: add it once if this install never had it
// (e.g. a custom agents.mjs without it). Deleting it later is respected.
if (!store.getMeta("architect_seeded")) {
  if (!store.get("agent-architect")) {
    const cfg = ((await loadConfig(CONFIG_DIR, "agents.example.mjs", "agents")) ?? []).find((a) => a.name === "agent-architect");
    const { errors, agent } = cfg ? validateAgent(cfg, "human", registry) : { errors: ["not in agents.example.mjs"] };
    if (errors.length) log("seed", `could not add agent-architect: ${errors.join("; ")}`);
    else store.upsert(agent, "human (initial import)");
  }
  store.setMeta("architect_seeded", new Date().toISOString());
}
tailEvents();

// ---------- keep cron jobs in sync with the database ----------
const jobs = new Map(); // name -> { schedule, task }
let lastVersion = -1;

async function scheduledRun(name) {
  // Busy (e.g. answering a chat): skip this time, without posting or clearing the chat's "working" state.
  if (engine.isRunning(name)) { log(name, "still busy, scheduled run skipped"); return; }
  bus.emit("running", { agent: name, running: true });
  try {
    const started = new Date().toISOString();
    const r = await engine.runAgent(name, { trigger: "schedule" });
    if (r.result && !r.busy) {
      bus.emit("message", store.addMessage(name, "agent", name, r.result, {
        meta: { model: r.model, effort: r.effort, turns: r.turns, ok: r.ok, task: true, scheduled: true, proposals: store.proposalIdsSince(name, started) },
      }));
    }
  } finally {
    bus.emit("running", { agent: name, running: engine.isRunning(name) });
  }
}

function reconcile() {
  const version = store.version();
  if (version === lastVersion) return;
  lastVersion = version;
  const wanted = new Map(store.list().filter((a) => a.enabled && a.schedule).map((a) => [a.name, a.schedule]));
  for (const [name, job] of jobs) {
    if (wanted.get(name) !== job.schedule) { job.task.stop(); jobs.delete(name); log(name, "unscheduled"); }
  }
  for (const [name, schedule] of wanted) {
    if (jobs.has(name)) continue;
    jobs.set(name, { schedule, task: cron.schedule(schedule, () => scheduledRun(name), { timezone: TZ }) });
    log(name, `scheduled "${schedule}" (${TZ})`);
  }
  bus.emit("refresh");
}

reconcile();
setInterval(() => { tailEvents(); reconcile(); }, 2_000);

if (process.env.UI_PASSWORD) {
  // A certificate the phones trust (e.g. from `tailscale cert` or mkcert): browsers only allow push notifications on https.
  const [cert, key] = await Promise.all(["cert.pem", "key.pem"].map((f) => readFile(path.join(CONFIG_DIR, "tls", f)).catch(() => null)));
  if (!cert !== !key) log("ui", "config/tls needs both cert.pem and key.pem: serving http");
  startUi({ store, engine, dataDir: DATA_DIR, bus, port: UI_PORT, password: process.env.UI_PASSWORD, log, tls: cert && key ? { cert, key } : null });
} else {
  log("ui", "UI_PASSWORD not set: chat UI disabled");
}
log("runner", `${store.count()} agent(s), ${jobs.size} scheduled. CLI: docker exec -it claude-agents agents help`);
