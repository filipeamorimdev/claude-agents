// Web UI: a WhatsApp-style chat with your agents, served from the agents container.
// Plain node:http, no framework. Password login (UI_PASSWORD), live updates over SSE.

import http from "node:http";
import crypto from "node:crypto";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MODELS, EFFORTS, turnsFor, diff } from "./store.mjs";
import { describeEvent } from "./events.mjs";

const UI_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "ui", "index.html");
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
const IMAGE_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
const MAX_UPLOAD = 10 * 1024 * 1024;
const COOKIE = "ca_session";
const SESSION_DAYS = 30;
const GROUP_MAX = 10;               // agents per group
const GROUP_WAIT_MS = 15 * 60e3;    // how long a group message waits for a busy member
const GROUP_HISTORY = 20;           // recent group messages each member sees
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function startUi({ store, engine, dataDir, bus, port, password, log }) {
  // ---------- auth ----------
  let secret = store.getMeta("ui_secret");
  if (!secret) { secret = crypto.randomBytes(32).toString("hex"); store.setMeta("ui_secret", secret); }
  const sign = (v) => crypto.createHmac("sha256", secret).update(v).digest("hex");
  const pwHash = crypto.createHash("sha256").update(password).digest();
  const attempts = new Map(); // ip -> [timestamps]

  const sessionCookie = () => {
    const exp = String(Date.now() + SESSION_DAYS * 864e5);
    return `${COOKIE}=${exp}.${sign(exp)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}`;
  };
  const authed = (req) => {
    const m = (req.headers.cookie ?? "").match(new RegExp(`${COOKIE}=(\\d+)\\.([a-f0-9]{64})`));
    if (!m || Number(m[1]) < Date.now()) return false;
    const a = Buffer.from(sign(m[1]), "hex"), b = Buffer.from(m[2], "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  // ---------- live updates (SSE) ----------
  const clients = new Set();
  const broadcast = (type, data) => {
    const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(payload);
  };
  bus.on("event", (e) => broadcast("event", { ...e, text: describeEvent(e) }));
  bus.on("message", (m) => broadcast("message", withProposals(m)));
  bus.on("running", (r) => broadcast("running", r));
  setInterval(() => { for (const res of clients) res.write(": ping\n\n"); }, 25_000).unref();

  // ---------- helpers ----------
  const send = (res, code, body, headers = {}) => {
    res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
    res.end(JSON.stringify(body));
  };
  const readBody = (req, limit) => new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error("too large"), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
  const json = async (req) => {
    if (!(req.headers["content-type"] ?? "").includes("application/json")) throw Object.assign(new Error("expected JSON"), { code: 415 });
    return JSON.parse((await readBody(req, 1024 * 1024)).toString() || "{}");
  };
  const agentView = (a, running) => ({
    name: a.name, description: a.description, enabled: a.enabled, schedule: a.schedule,
    model: a.model, effort: a.effort, maxTurns: a.maxTurns, tools: a.tools, running: running.includes(a.name),
  });
  const addMessage = (...args) => { const m = store.addMessage(...args); bus.emit("message", m); return m; };
  // A reply that made suggestions carries them (current status included), so the chat can show Approve/Reject under it.
  function withProposals(m) {
    if (!m.meta?.proposals?.length) return m;
    const proposals = m.meta.proposals.map((id) => store.proposal(id)).filter(Boolean).map((p) => ({
      id: p.id, kind: p.kind, agent: p.agent, status: p.status, reason: p.reason,
      description: p.config.description, schedule: p.config.schedule, tools: p.config.tools,
      changes: p.kind === "update" && p.status === "open" ? Object.keys(diff(store.get(p.agent), p.config)) : [],
    }));
    return { ...m, proposals };
  }

  async function loadImages(chat, attachments) {
    const out = [];
    for (const a of attachments) {
      const file = path.join(dataDir, "workspaces", chat, a.path);
      const ext = path.extname(file).slice(1);
      const mediaType = Object.entries(IMAGE_TYPES).find(([, e]) => e === ext)?.[0];
      if (mediaType) out.push({ mediaType, data: (await readFile(file)).toString("base64") });
    }
    return out;
  }

  /** Run an agent for a chat message and post its reply. With waitMs, waits for a busy agent first. */
  async function respond({ agent, chat, text, attachments = [], model, effort, resumeChat, waitMs = 0 }) {
    for (const until = Date.now() + waitMs; engine.isRunning(agent) && Date.now() < until;) await sleep(3000);
    if (engine.isRunning(agent)) {
      addMessage(chat, "system", "system", `${agent} is busy with another task. Try again in a moment.`);
      return;
    }
    bus.emit("running", { agent, running: true });
    try {
      const images = await loadImages(agent, attachments);
      const started = new Date().toISOString();
      const r = await engine.runAgent(agent, {
        trigger: chat.startsWith("group:") ? chat : "chat",
        message: text || "(see the attached image)",
        images, chat: resumeChat, model, effort,
        onProgress: (p) => broadcast("progress", { agent, chat, ...p }),
      });
      addMessage(chat, "agent", agent, r.result, {
        meta: { model: r.model, effort: r.effort, turns: r.turns, ok: r.ok, proposals: store.proposalIdsSince(agent, started) },
      });
    } finally {
      bus.emit("running", { agent, running: false });
    }
  }

  // ---------- routes ----------
  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, re: new RegExp(`^${pattern}$`), handler });

  route("GET", "/api/me", (req, res) => send(res, authed(req) ? 200 : 401, { ok: authed(req) }));

  route("POST", "/api/login", async (req, res) => {
    const ip = req.socket.remoteAddress;
    const recent = (attempts.get(ip) ?? []).filter((t) => Date.now() - t < 10 * 60e3);
    if (recent.length >= 10) return send(res, 429, { error: "Too many attempts. Wait 10 minutes." });
    const { password: given = "" } = await json(req);
    const ok = crypto.timingSafeEqual(crypto.createHash("sha256").update(String(given)).digest(), pwHash);
    if (!ok) { attempts.set(ip, [...recent, Date.now()]); log("ui", `failed login from ${ip}`); return send(res, 401, { error: "Wrong password" }); }
    attempts.delete(ip);
    send(res, 200, { ok: true }, { "Set-Cookie": sessionCookie() });
  });

  route("POST", "/api/logout", (req, res) =>
    send(res, 200, { ok: true }, { "Set-Cookie": `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` }));

  route("GET", "/api/state", (req, res) => {
    const running = store.runningAgents();
    const last = Object.fromEntries(store.lastMessages().map((m) => [m.chat, m]));
    send(res, 200, {
      agents: store.list().map((a) => ({ ...agentView(a, running), last: last[a.name] ?? null })),
      groups: store.groups().map((g) => ({ ...g, last: last[`group:${g.id}`] ?? null })),
      proposals: store.proposals("open").length,
      models: MODELS,
      efforts: Object.fromEntries(Object.keys(EFFORTS).map((k) => [k, turnsFor(k)])),
    });
  });

  route("GET", "/api/agents/([a-z0-9-]+)", (req, res, [name]) => {
    const a = store.get(name);
    if (!a) return send(res, 404, { error: "no such agent" });
    send(res, 200, { ...agentView(a, store.runningAgents()), prompt: a.prompt, createdBy: a.createdBy, runs: store.runs(name, 10) });
  });

  route("POST", "/api/agents/([a-z0-9-]+)/(enable|disable|reset|run)", async (req, res, [name, action]) => {
    if (!store.get(name)) return send(res, 404, { error: "no such agent" });
    if (action === "enable" || action === "disable") store.setEnabled(name, action === "enable", "human (ui)");
    if (action === "reset") {
      store.clearSession(name);
      addMessage(name, "system", "system", "New conversation started. Earlier messages are no longer in the agent's context.");
    }
    if (action === "run") {
      if (engine.isRunning(name)) return send(res, 409, { error: `${name} is already running` });
      addMessage(name, "system", "system", "Running scheduled task now…");
      bus.emit("running", { agent: name, running: true });
      const started = new Date().toISOString();
      engine.runAgent(name, { trigger: "manual", onProgress: (p) => broadcast("progress", { agent: name, chat: name, ...p }) })
        .then((r) => addMessage(name, "agent", name, r.result, {
          meta: { model: r.model, effort: r.effort, turns: r.turns, ok: r.ok, task: true, proposals: store.proposalIdsSince(name, started) },
        }))
        .finally(() => bus.emit("running", { agent: name, running: false }));
    }
    send(res, 200, { ok: true });
  });

  route("GET", "/api/chats/([a-z0-9-]+)/messages", (req, res, [chat], url) => {
    const before = url.searchParams.get("before");
    send(res, 200, { messages: store.messages(chat, before ? Number(before) : null).map(withProposals) });
  });

  route("POST", "/api/chats/([a-z0-9-]+)/messages", async (req, res, [name]) => {
    const agent = store.get(name);
    if (!agent) return send(res, 404, { error: "no such agent" });
    const { text = "", model = agent.model, effort = agent.effort, attachments = [] } = await json(req);
    if (!String(text).trim() && !attachments.length) return send(res, 400, { error: "empty message" });
    if (!MODELS.includes(model) || !EFFORTS[effort]) return send(res, 400, { error: "invalid model or effort" });
    const files = attachments.filter((p) => /^uploads\/[\w.-]+$/.test(p)).slice(0, 5);
    store.setSettings(name, { model, effort }, "human (ui)"); // sticky, logged only if changed
    const msg = addMessage(name, "human", "you", String(text), {
      attachments: files.map((p) => ({ path: p, url: `/api/files/${name}/${p}` })), meta: { model, effort },
    });
    send(res, 202, { message: msg });
    respond({ agent: name, chat: name, text: String(text), attachments: msg.attachments, model, effort, resumeChat: true })
      .catch((e) => log("ui", `chat error: ${e.message}`));
  });

  // Groups: every member agent gets each message and replies in the group, one after another.
  const groupInput = async (req) => {
    const { name = "", members = [] } = await json(req);
    const clean = String(name).replace(/\s+/g, " ").trim();
    const list = [...new Set((Array.isArray(members) ? members : []).map(String))];
    const unknown = list.filter((m) => !store.get(m));
    if (!clean || clean.length > 40) throw Object.assign(new Error("Give the group a name (up to 40 characters)"), { code: 400 });
    if (unknown.length) throw Object.assign(new Error(`No agent called ${unknown.join(", ")}`), { code: 400 });
    if (list.length < 2 || list.length > GROUP_MAX) throw Object.assign(new Error(`Pick 2 to ${GROUP_MAX} agents`), { code: 400 });
    return { name: clean, members: list };
  };

  route("POST", "/api/groups", async (req, res) => {
    const { name, members } = await groupInput(req);
    const g = store.createGroup(name, members, "human (ui)");
    addMessage(`group:${g.id}`, "system", "system", `You created this group with ${members.join(", ")}. Everyone here gets every message you send.`);
    send(res, 200, { group: g });
  });

  route("PATCH", "/api/groups/(\\d+)", async (req, res, [id]) => {
    const before = store.group(Number(id));
    if (!before) return send(res, 404, { error: "no such group" });
    const g = store.updateGroup(Number(id), await groupInput(req), "human (ui)");
    const added = g.members.filter((m) => !before.members.includes(m)), removed = before.members.filter((m) => !g.members.includes(m));
    if (added.length || removed.length) {
      addMessage(`group:${g.id}`, "system", "system",
        [added.length && `You added ${added.join(", ")}.`, removed.length && `You removed ${removed.join(", ")}.`].filter(Boolean).join(" "));
    }
    send(res, 200, { group: g });
  });

  route("DELETE", "/api/groups/(\\d+)", (req, res, [id]) => {
    if (!store.group(Number(id))) return send(res, 404, { error: "no such group" });
    store.deleteGroup(Number(id), "human (ui)");
    send(res, 200, { ok: true });
  });

  route("GET", "/api/groups/(\\d+)/messages", (req, res, [id], url) => {
    if (!store.group(Number(id))) return send(res, 404, { error: "no such group" });
    const before = url.searchParams.get("before");
    send(res, 200, { messages: store.messages(`group:${id}`, before ? Number(before) : null).map(withProposals) });
  });

  const groupQueues = new Map(); // group id -> promise of the delivery in progress (keeps messages in order)
  route("POST", "/api/groups/(\\d+)/messages", async (req, res, [id]) => {
    const g = store.group(Number(id));
    if (!g) return send(res, 404, { error: "no such group" });
    const { text = "" } = await json(req);
    if (!String(text).trim()) return send(res, 400, { error: "empty message" });
    const chat = `group:${g.id}`;
    const msg = addMessage(chat, "human", "you", String(text).trim());
    send(res, 202, { message: msg });
    const next = (groupQueues.get(g.id) ?? Promise.resolve())
      .then(() => deliverToGroup(g.id, msg.id))
      .catch((e) => log("ui", `group error: ${e.message}`));
    groupQueues.set(g.id, next);
    next.then(() => { if (groupQueues.get(g.id) === next) groupQueues.delete(g.id); });
  });

  /** Give one human message to every member, in order; each sees the group conversation so far. */
  async function deliverToGroup(id, messageId) {
    const chat = `group:${id}`;
    for (const name of store.group(id)?.members ?? []) {
      const g = store.group(id), agent = store.get(name);
      if (!g || !g.members.includes(name)) continue; // group deleted or member removed meanwhile
      if (!agent) { addMessage(chat, "system", "system", `${name} no longer exists and didn't get this message.`); continue; }
      if (!agent.enabled) { addMessage(chat, "system", "system", `${name} is turned off and didn't get this message.`); continue; }
      const others = g.members.filter((m) => m !== name).map((m) => `${m} (${store.get(m)?.description || "agent"})`);
      const history = store.messages(chat, messageId + 1, GROUP_HISTORY).filter((m) => m.role !== "system")
        .map((m) => `[${m.role === "human" ? "human" : m.author}] ${m.text.slice(0, 1500)}`);
      const later = store.messages(chat, null, GROUP_HISTORY).filter((m) => m.id > messageId && m.role === "agent")
        .map((m) => `[${m.author}] ${m.text.slice(0, 1500)}`);
      const prompt = [
        `You are ${name}, in the group chat "${g.name}" with the human and these agents: ${others.join(", ")}.`,
        "Every member gets each message from the human and answers in the group, one after another.",
        "", "Conversation (oldest first):", ...history, ...later, "",
        `Answer the human's latest message as ${name}, within your own job. Build on what the others already said instead of repeating it. ` +
        "Reply in the language of the human's latest message.",
      ].join("\n");
      await respond({ agent: name, chat, text: prompt, resumeChat: false, waitMs: GROUP_WAIT_MS });
    }
  }

  route("POST", "/api/uploads", async (req, res, _m, url) => {
    const chat = url.searchParams.get("chat") ?? "";
    if (!NAME_RE.test(chat) || !store.get(chat)) return send(res, 400, { error: "unknown agent" });
    const ext = IMAGE_TYPES[(req.headers["content-type"] ?? "").split(";")[0]];
    if (!ext) return send(res, 415, { error: "only JPEG, PNG, WebP or GIF images" });
    const body = await readBody(req, MAX_UPLOAD);
    const dir = path.join(dataDir, "workspaces", chat, "uploads");
    await mkdir(dir, { recursive: true });
    const name = `${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}-${crypto.randomBytes(3).toString("hex")}.${ext}`;
    await writeFile(path.join(dir, name), body);
    send(res, 200, { path: `uploads/${name}`, url: `/api/files/${chat}/uploads/${name}` });
  });

  route("GET", "/api/files/([a-z0-9-]+)/uploads/([\\w.-]+)", async (req, res, [chat, file]) => {
    const full = path.join(dataDir, "workspaces", chat, "uploads", file);
    const type = Object.entries(IMAGE_TYPES).find(([, e]) => e === path.extname(file).slice(1))?.[0];
    try {
      if (!type) throw new Error();
      await stat(full);
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "private, max-age=86400" });
      createReadStream(full).pipe(res);
    } catch { send(res, 404, { error: "not found" }); }
  });

  route("GET", "/api/proposals", (req, res) => {
    send(res, 200, {
      proposals: store.proposals("open").map((p) => ({ ...p, current: store.get(p.agent) ?? null, diff: diff(store.get(p.agent), p.config) })),
    });
  });

  route("POST", "/api/proposals/(\\d+)/(approve|reject)", (req, res, [id, action]) => {
    try {
      const p = store.decide(Number(id), action === "approve", "human (ui)", engine.registry);
      send(res, 200, { ok: true, proposal: p });
    } catch (e) { send(res, 409, { error: e.message }); }
  });

  route("GET", "/api/stream", (req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write(`event: hello\ndata: {}\n\n`);
    clients.add(res);
    for (const agent of store.runningAgents()) res.write(`event: running\ndata: ${JSON.stringify({ agent, running: true })}\n\n`);
    req.on("close", () => clients.delete(res));
  });

  // ---------- server ----------
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    try {
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
          "Content-Security-Policy": "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
        });
        return res.end(await readFile(UI_FILE));
      }
      if (!url.pathname.startsWith("/api/")) return send(res, 404, { error: "not found" });
      const open = url.pathname === "/api/login" || url.pathname === "/api/me";
      if (!open && !authed(req)) return send(res, 401, { error: "login required" });
      for (const r of routes) {
        const m = r.method === req.method && url.pathname.match(r.re);
        if (m) return await r.handler(req, res, m.slice(1), url);
      }
      send(res, 404, { error: "not found" });
    } catch (e) {
      if (!res.headersSent) send(res, e.code >= 400 && e.code < 600 ? e.code : 500, { error: e.message });
      if (!(e.code >= 400 && e.code < 500)) log("ui", `error ${req.method} ${url.pathname}: ${e.message}`);
    }
  });
  server.listen(port, "0.0.0.0", () => log("ui", `chat UI listening on port ${port}`));
  return server;
}
