// The vault: site logins for the browser agent, kept where no agent can reach them.
// Runs as its own container (service "vault", same image as the app): node vault.mjs
//
//   - values are encrypted at rest (AES-256-GCM) in /vault/logins.json with the key in /vault/vault.key.
//     Encrypted, not hashed: the browser has to type the real value into the site's form.
//     Only this container mounts /vault (DATA_DIR/vault); the agents' container doesn't.
//   - its API (internal network only, no published port) saves, lists and deletes logins and the sites
//     the browser may open, but never returns a value. The chat UI sends what you type straight here.
//     Every call but /health must be signed with the app's control key (control.mjs): other containers on its
//     network, and an agent's own commands inside the app's container, can't list, grant or change anything
//   - each login lists the agents that may use it (grants): no grant, no use. Saving a login an agent
//     asked for grants it to that agent; the chat UI changes the rest.
//   - it writes the decrypted logins to the in-memory folder it shares with the browser, one file per agent
//     with only the logins granted to it (agents/<agent>.env, Playwright's --secrets dotenv file), plus the
//     sites and the grants. The browser runs a separate browser for each agent with that agent's file and
//     restarts it when the file or the sites change; its guard (app/browser/mcp-guard.mjs) reads the grants
//     on every call
//   - a login whose site is a device on your network (http://IP:PORT) is also written, for each agent it's granted to,
//     to the in-memory folder it shares with the LAN gateway (LAN_LOGINS_OUT, <agent>.json): `lan-ssh` signs in to that
//     device (same IP) with it as an ssh password. The gateway runs ssh itself: the agent still never sees the value
//   - BROWSER_SECRETS and BROWSER_ALLOWED_ORIGINS from the stack's variables are included, read-only here

import http from "node:http";
import crypto from "node:crypto";
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { LOGIN_NAME_RE, AGENT_NAME_RE, MAX_LOGIN_VALUE, loginSite, siteRule, deviceOf } from "./logins.mjs";
import { verifier } from "./control.mjs";

const DIR = process.env.VAULT_DIR || "/vault";
const OUT = process.env.VAULT_OUT || "/run/browser-secrets";
const LAN_OUT = process.env.LAN_LOGINS_OUT || "/run/lan-logins";
const PORT = Number(process.env.VAULT_PORT || 8932);
const STORE = path.join(DIR, "logins.json");
const KEY_FILE = path.join(DIR, "vault.key");
const MAX_LOGINS = 200, MAX_SITES = 50;
const log = (msg) => console.log(`${new Date().toISOString()} [vault] ${msg}`);
const now = () => new Date().toISOString();

// ---------- storage ----------

function loadKey() {
  if (!existsSync(KEY_FILE)) {
    writeFileSync(KEY_FILE, crypto.randomBytes(32).toString("base64") + "\n", { mode: 0o600, flag: "wx" });
    log("created a new key (vault.key)");
  }
  const key = Buffer.from(readFileSync(KEY_FILE, "utf8").trim(), "base64");
  if (key.length !== 32) throw new Error(`${KEY_FILE} is not a 32-byte key`);
  return key;
}
const key = loadKey();

// The login's name is the additional data, so an encrypted value can't be moved to another name.
const seal = (name, value) => {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv).setAAD(Buffer.from(name));
  const data = Buffer.concat([c.update(value, "utf8"), c.final()]);
  return { iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") };
};
const open = (name, { iv, tag, data }) => {
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64")).setAAD(Buffer.from(name));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]).toString("utf8");
};

/** { logins: { NAME: { site, updatedAt, iv, tag, data } }, sites: [rule], grants: { NAME: [agent] } } */
const vault = existsSync(STORE) ? JSON.parse(readFileSync(STORE, "utf8")) : { logins: {}, sites: [] };
vault.grants ??= {};
vault.siteNotes ??= {}; // rule -> what the browser opens it for (yours, shown in the agents' details)
const NOTE_MAX = 200;
const cleanNote = (n) => String(n ?? "").replace(/\s+/g, " ").trim().slice(0, NOTE_MAX);
const persist = () => {
  writeFileSync(`${STORE}.tmp`, JSON.stringify(vault, null, 2), { mode: 0o600 });
  renameSync(`${STORE}.tmp`, STORE);
};

// From the stack's variables: BROWSER_SECRETS="NAME=value;NAME=value" and BROWSER_ALLOWED_ORIGINS="a;b".
const stackLogins = Object.fromEntries((process.env.BROWSER_SECRETS ?? "").split(";").map((p) => p.trim()).filter(Boolean)
  .map((p) => [p.slice(0, p.indexOf("=")).trim(), p.slice(p.indexOf("=") + 1).trim().replace(/^(['"`])([\s\S]*)\1$/, "$2")])
  .filter(([name]) => name));
const stackSites = (process.env.BROWSER_ALLOWED_ORIGINS ?? "").split(";").map((s) => s.trim()).filter(Boolean);

// ---------- what the browser reads ----------

// Written so Playwright's dotenv parser gives the value back unchanged (values never contain a line break):
// in a quote the value doesn't use; bare when it ends in "\" (which would escape any closing quote).
const quoted = (v) => {
  const q = !v.endsWith("\\") && ["'", "`", '"'].find((c) => !v.includes(c) && !(c === '"' && /\\[nr]/.test(v)));
  if (q) return q + v + q;
  if (!v.includes("#") && !/^['"`]/.test(v) && v === v.trim()) return v;
  throw Object.assign(new Error("This value can't be stored for the browser: change its mix of quotes, # and a final \\"), { code: 400 });
};

function writeIfChanged(file, text, dir = OUT) {
  const full = path.join(dir, file);
  if (existsSync(full) && readFileSync(full, "utf8") === text) return;
  writeFileSync(`${full}.tmp`, text, { mode: 0o600 });
  renameSync(`${full}.tmp`, full); // the browser never reads a half-written file
}

function publish() {
  const values = { ...stackLogins };
  for (const [name, entry] of Object.entries(vault.logins)) {
    try { values[name] = open(name, entry); } catch { log(`could not decrypt ${name} (wrong vault.key?), left out`); }
  }
  const lines = Object.fromEntries(Object.entries(values).map(([n, v]) => {
    try { return [n, `${n}=${quoted(v)}\n`]; } catch { log(`${n} can't be written for the browser (it holds ', " and \`), left out`); return [n, ""]; }
  }));
  // Each agent's browser gets only the logins granted to that agent.
  const byAgent = {};
  for (const n of Object.keys(values)) for (const a of vault.grants[n] ?? []) (byAgent[a] ??= []).push(lines[n]);
  mkdirSync(path.join(OUT, "agents"), { recursive: true, mode: 0o700 });
  for (const [a, l] of Object.entries(byAgent)) writeIfChanged(`agents/${a}.env`, l.join(""));
  for (const f of readdirSync(path.join(OUT, "agents"))) if (!byAgent[f.replace(/\.env$/, "")]) rmSync(path.join(OUT, "agents", f));
  rmSync(path.join(OUT, "secrets.env"), { force: true }); // every login in one file, from before browsers were per agent
  writeIfChanged("origins", vault.sites.map((s) => `${s}\n`).join(""));
  // Every name the browser knows, with the agents that may type it (an empty list: nobody).
  writeIfChanged("grants.json", JSON.stringify(Object.fromEntries(Object.keys(values).map((n) => [n, vault.grants[n] ?? []]))));
  publishDeviceLogins(values);
}

// For the LAN gateway's ssh: each agent's logins for a device on your network, { NAME: { host, value } }.
function publishDeviceLogins(values) {
  if (!existsSync(LAN_OUT)) return; // the gateway's folder isn't mounted (an older compose file)
  const byAgent = {};
  for (const [name, entry] of Object.entries(vault.logins)) {
    const device = deviceOf(entry.site ?? "");
    if (!device || values[name] == null) continue;
    for (const a of vault.grants[name] ?? []) (byAgent[a] ??= {})[name] = { host: device.host, value: values[name] };
  }
  try {
    for (const [a, l] of Object.entries(byAgent)) writeIfChanged(`${a}.json`, JSON.stringify(l), LAN_OUT);
    for (const f of readdirSync(LAN_OUT)) if (f.endsWith(".json") && !byAgent[f.replace(/\.json$/, "")]) rmSync(path.join(LAN_OUT, f));
  } catch (e) { log(`could not write the device logins for the LAN gateway: ${e.message}`); }
}

const agentList = (agents) => {
  if (!Array.isArray(agents) || agents.some((a) => !AGENT_NAME_RE.test(String(a)))) fail(400, "agents: a list of agent names");
  return [...new Set(agents.map(String))].sort();
};

// ---------- API ----------

const send = (res, code, body) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const BODY_MAX = 16 * 1024;
const readRaw = (req) => new Promise((resolve, reject) => {
  const chunks = []; let size = 0;
  req.on("data", (c) => { size += c.length; if (size > BODY_MAX) { reject(Object.assign(new Error("too large"), { code: 413 })); req.destroy(); } else chunks.push(c); });
  req.on("end", () => resolve(Buffer.concat(chunks).toString()));
  req.on("error", reject);
});
// JSON only (a web page can't send that without asking first, CORS, and the vault never says yes), and signed anyway.
const parseJson = (req, raw) => {
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) fail(415, "expected JSON");
  try { return JSON.parse(raw || "{}"); } catch { return fail(400, "invalid JSON"); }
};
const signed = verifier();

const listing = () => ({
  logins: [
    ...Object.entries(vault.logins).map(([name, e]) => ({ name, site: e.site ?? "", source: "vault", updatedAt: e.updatedAt })),
    ...Object.keys(stackLogins).filter((n) => !vault.logins[n]).map((name) => ({ name, site: "", source: "stack", updatedAt: null })),
  ].map((l) => ({ ...l, agents: vault.grants[l.name] ?? [] })).sort((a, b) => a.name.localeCompare(b.name)),
  sites: [...stackSites.map((rule) => ({ rule, source: "stack" })), ...vault.sites.filter((s) => !stackSites.includes(s)).map((rule) => ({ rule, source: "vault" }))]
    .map((s) => ({ ...s, note: vault.siteNotes[s.rule] ?? "" })),
});

async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const m = url.pathname.match(/^\/logins\/([^/]+)$/);
  if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });
  const raw = await readRaw(req);
  if (!signed(req, raw)) {
    log(`refused an unsigned ${req.method} ${url.pathname} from ${String(req.socket.remoteAddress ?? "").replace(/^::ffff:/, "")}`);
    return send(res, 403, { error: "only the app" });
  }
  const readJson = () => parseJson(req, raw);
  if (req.method === "GET" && url.pathname === "/logins") return send(res, 200, listing());

  if (req.method === "PUT" && m) {
    const name = m[1];
    if (!LOGIN_NAME_RE.test(name)) fail(400, "Name: capital letters, digits and _, starting with a letter (e.g. VINTED_PASSWORD)");
    const { value, site = "", grant = [] } = readJson();
    const granted = agentList(grant);
    if (typeof value !== "string" || !value) fail(400, `Type a value for ${name}`);
    if (value.length > MAX_LOGIN_VALUE) fail(400, `${name} is too long`);
    if (/[\r\n]/.test(value)) fail(400, `${name} can't contain a line break`);
    quoted(value);
    const origin = site ? loginSite(site) : "";
    if (origin === null) fail(400, `“${site}” isn't a website address or a device on your network`);
    if (!vault.logins[name] && Object.keys(vault.logins).length >= MAX_LOGINS) fail(400, `The vault holds at most ${MAX_LOGINS} logins`);
    vault.logins[name] = { site: origin || vault.logins[name]?.site || "", updatedAt: now(), ...seal(name, value) };
    if (granted.length) vault.grants[name] = agentList([...(vault.grants[name] ?? []), ...granted]);
    persist(); publish();
    log(`saved ${name}${origin ? ` (${origin})` : ""}${granted.length ? `, for ${granted.join(", ")}` : ""}`);
    return send(res, 200, { ok: true });
  }

  if (req.method === "DELETE" && m) {
    const name = m[1];
    if (!vault.logins[name]) fail(stackLogins[name] ? 400 : 404, stackLogins[name]
      ? `${name} comes from BROWSER_SECRETS in the stack's variables: remove it there and redeploy` : `No login called ${name}`);
    delete vault.logins[name];
    if (!stackLogins[name]) delete vault.grants[name];
    persist(); publish();
    log(`deleted ${name}${stackLogins[name] ? " (BROWSER_SECRETS still sets it)" : ""}`);
    return send(res, 200, { ok: true });
  }

  const g = url.pathname.match(/^\/grants\/([^/]+)$/);
  if (req.method === "POST" && g) {
    const name = g[1];
    if (!vault.logins[name] && !stackLogins[name]) fail(404, `No login called ${name}`);
    const agents = agentList((readJson()).agents);
    if (agents.length) vault.grants[name] = agents; else delete vault.grants[name];
    persist(); publish();
    log(`${name} may be used by ${agents.join(", ") || "no agent"}`);
    return send(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/sites") {
    // { add, note? }, { remove }, or { describe: rule, note }: what a site is for ("" removes the note).
    const { add, remove, describe, note } = readJson();
    if (add != null) {
      const rule = siteRule(add);
      if (!rule && deviceOf(add)) fail(400, `${add} is a device on your network: ask the agent in its chat: it asks you for access to it there`);
      if (!rule) fail(400, `“${add}” isn't a website: use an address like https://www.vinted.pt, a host like vinted.pt, or *.vinted.pt`);
      if (!vault.sites.includes(rule) && !stackSites.includes(rule)) {
        if (vault.sites.length >= MAX_SITES) fail(400, `At most ${MAX_SITES} sites`);
        vault.sites.push(rule);
        log(`the browser may open ${rule}`);
      }
      if (cleanNote(note)) vault.siteNotes[rule] = cleanNote(note);
    }
    if (describe != null) {
      const rule = siteRule(describe) ?? String(describe);
      if (!vault.sites.includes(rule) && !stackSites.includes(rule)) fail(404, `The browser can't open ${rule}: add it first`);
      if (cleanNote(note)) vault.siteNotes[rule] = cleanNote(note); else delete vault.siteNotes[rule];
    }
    if (remove != null) {
      const rule = siteRule(remove) ?? String(remove);
      if (stackSites.includes(rule)) fail(400, `${rule} comes from BROWSER_ALLOWED_ORIGINS in the stack's variables: remove it there and redeploy`);
      if (vault.sites.includes(rule)) { vault.sites = vault.sites.filter((s) => s !== rule); delete vault.siteNotes[rule]; log(`the browser may no longer open ${rule}`); }
    }
    persist(); publish();
    return send(res, 200, listing());
  }
  send(res, 404, { error: "not found" });
}

publish();
http.createServer((req, res) => handle(req, res).catch((e) => {
  // Never echo a request body: it may hold a value.
  send(res, e.code >= 400 && e.code < 500 ? e.code : 500, { error: e.code >= 400 && e.code < 500 ? e.message : "vault error" });
  if (!(e.code >= 400 && e.code < 500)) log(`error ${req.method} ${req.url}: ${e.message}`);
})).listen(PORT, "0.0.0.0", () => {
  const { logins, sites } = listing();
  log(`listening on port ${PORT}: ${logins.length} login(s), ${sites.length} site(s)`);
});
