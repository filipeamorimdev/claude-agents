// The LAN gateway: the only way an agent's command reaches your home network.
// Runs as its own container (service "lan", same image as the app): node lan.mjs
//
// Nothing reaches the LAN by default. You add targets, each ONE device's IP and ONE port (never a subnet), and
// grant each target to the agents that may use it, read-only or full. Then:
//   - the firewall lets only this container out to exactly those IP:port pairs (it polls GET /allow). The command
//     sandbox and the app's own container still can't reach any of them directly
//   - a command the human approved (or one a rule auto-approves with LAN access) gets a token that lives as long as
//     that command. Its `lan <command>` uses this gateway as an HTTP proxy, and the gateway lets it reach only its
//     agent's granted targets
//   - read-only: plain http:// requests with GET, HEAD or OPTIONS only, nothing else (no tunnels, so no ssh)
//   - full: any method, and tunnels (CONNECT: https end to end, ssh with lan-connect)
//   - a target's credential (an API key, a token, a password) is kept here, encrypted (AES-256-GCM, key in
//     DATA_DIR/lan/lan.key, a folder only this container mounts), and added to the agent's http:// requests on the
//     way out. The agent never sees it: it isn't in the sandbox, the app, the database or the logs. A target that
//     speaks https gets https from here (`tls`), so the agent still talks plain http to the gateway
//   - ssh: a target can hold an SSH key (generated here, so the private half never leaves this container, or pasted
//     once), encrypted like a credential. A full-access command runs `lan-ssh <device> <command>`: this gateway runs
//     ssh itself with that key and sends back only the output. The agent never sees the key. The device's host key
//     is pinned on first use (DATA_DIR/lan/known_hosts/<target>); a changed host key fails until you reset the key.
//     Or a password from the vault: a login whose site is that device (same IP) and that you granted to the agent there.
//     The vault hands this gateway only those (an in-memory folder, LAN_LOGINS_DIR/<agent>.json); ssh gets the password
//     from lan-askpass here, so it never reaches the agent either. `lan-ssh --sudo NAME` runs the command with sudo on
//     the device, and this gateway types such a login into sudo's prompt (sudo -S), once, only when sudo asks
//   - an agent's browser: for each grant you also tick whether its browser may open that device. The browser container
//     reaches this gateway on a network of its own (internal, only the two of them: LAN_BROWSER_IP), and the guard there
//     sends only the private addresses its agent was given here (browser/mcp-guard.mjs). Same modes: read-only is GET,
//     HEAD and OPTIONS. A device that speaks https is opened as http:// (the gateway does the https), so a self-signed
//     certificate doesn't stop the browser. A browser never gets ssh
//   - every proxied request and every ssh command is logged (docker logs claude-agents-lan): agent, target, what, result
//   - its control API (targets, grants, credentials, tokens) answers only calls signed by the app (control.mjs);
//     it never returns a credential
//
// Also the shared rules (targets, presets) and the client the app uses (lanClient).

import http from "node:http";
import https from "node:https";
import net from "node:net";
import crypto from "node:crypto";
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signer, verifier } from "./control.mjs";
import { privateIPv4 } from "./address.mjs";

export { privateIPv4 };

export const LAN_PORT = 8934;
export const LAN_MODES = ["read", "full"];
export const TARGET_ID_RE = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/;
const AGENT_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
const HEADER_RE = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const MAX_TARGETS = 100, MAX_SECRET = 4096;
export const SSH_USER_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/;
export const SSH_COMMAND_MAX = 2000;
const SSH_KEY_MAX = 16 * 1024, SSH_OUTPUT_MAX = 200_000, SSH_TIMEOUT_MAX = 600;

// Ready-made targets for the usual homelab services. The credential goes into `header` as `format` says
// ({} = the value, {base64} = the value base64-encoded, e.g. "user:password" for Basic auth).
export const PRESETS = {
  homeassistant: { label: "Home Assistant", port: 8123, header: "Authorization", format: "Bearer {}", secret: "Long-lived access token",
    hint: "Your profile in Home Assistant → Security → Long-lived access tokens. Read-only: GET /api/states, /api/config, /api/history/period." },
  portainer: { label: "Portainer", port: 9443, tls: true, header: "X-API-Key", format: "{}", secret: "Access token",
    hint: "My account → Access tokens. Read-only: GET /api/endpoints, /api/endpoints/<id>/docker/containers/json." },
  radarr: { label: "Radarr", port: 7878, header: "X-Api-Key", format: "{}", secret: "API key", hint: "Settings → General → API Key. GET /api/v3/system/status, /api/v3/queue." },
  sonarr: { label: "Sonarr", port: 8989, header: "X-Api-Key", format: "{}", secret: "API key", hint: "Settings → General → API Key. GET /api/v3/system/status, /api/v3/queue." },
  qbittorrent: { label: "qBittorrent", port: 8080, hint: "No key: in its Web UI options, tick \"Bypass authentication for clients in whitelisted IP subnets\" and add this server's LAN address. GET /api/v2/torrents/info, /api/v2/transfer/info." },
  jellyfin: { label: "Jellyfin", port: 8096, header: "X-Emby-Token", format: "{}", secret: "API key", hint: "Dashboard → API Keys. GET /System/Info, /Sessions." },
  frigate: { label: "Frigate", port: 5000, hint: "Port 5000 needs no login (8971 with tls does: use full access and a Bearer token there). GET /api/stats, /api/events." },
  adguard: { label: "AdGuard Home", port: 80, header: "Authorization", format: "Basic {base64}", secret: "user:password", hint: "GET /control/status, /control/stats, /control/querylog." },
  truenas: { label: "TrueNAS", port: 443, tls: true, header: "Authorization", format: "Bearer {}", secret: "API key", hint: "Top right → API Keys. GET /api/v2.0/system/info, /api/v2.0/pool, /api/v2.0/app." },
  other: { label: "Something else", port: 80 },
};

const isIPv4 = (s) => net.isIPv4(String(s ?? "")) && !/^0\.|^127\.|^255\./.test(s);
/** A host name or address an agent shouldn't fetch from the app's container (WebFetch): the LAN, this host, the stack. */
export function privateHost(host) {
  const h = String(host ?? "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (net.isIPv4(h)) { const [a, b] = h.split(".").map(Number); return privateIPv4(h) || a === 127 || a === 0 || (a === 169 && b === 254); }
  if (net.isIPv6(h)) return h === "::1" || /^(fc|fd|fe8|fe9|fea|feb)/.test(h) || h.startsWith("::ffff:");
  return !h.includes(".") || /\.(local|lan|home|internal|localdomain|home\.arpa|localhost)$/.test(h);
}

/** Validate a target from the UI or CLI. Returns { errors, target }. */
export function validateTarget(t = {}) {
  const errors = [];
  const id = String(t.id ?? "").trim().toLowerCase();
  if (!TARGET_ID_RE.test(id)) errors.push("id: 2-32 characters, lowercase letters, digits and dashes");
  const name = String(t.name ?? "").replace(/\s+/g, " ").trim().slice(0, 60) || id;
  const host = String(t.host ?? "").trim();
  if (!isIPv4(host)) errors.push("host: one IPv4 address, e.g. 192.168.1.50 (no names, no subnets)");
  else if (!privateIPv4(host)) errors.push("host: an address on your network (10.x, 172.16-31.x, 192.168.x or 100.64-127.x)");
  const port = Number(t.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push("port: 1 to 65535");
  const mode = String(t.mode ?? "read");
  if (!LAN_MODES.includes(mode)) errors.push('mode: "read" or "full"');
  const preset = PRESETS[t.preset] ? t.preset : "other";
  const note = String(t.note ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  return { errors, target: { id, name, host, port, mode, tls: !!t.tls, verifyTls: !!t.verifyTls, preset, note } };
}

/** The app's side of the control API. Never sees a credential back. */
export function lanClient(url = process.env.LAN_URL || `http://lan:${LAN_PORT}`) {
  const sign = signer();
  const call = async (method, p, body) => {
    const raw = body == null ? "" : JSON.stringify(body);
    let res;
    try {
      res = await fetch(url + p, {
        method, headers: { ...(body == null ? {} : { "Content-Type": "application/json" }), ...sign(method, p, raw) },
        body: body == null ? undefined : raw, signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw Object.assign(new Error("The LAN gateway isn't running (the stack's \"lan\" container)."), { code: 503 });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `The LAN gateway answered ${res.status}`), { code: res.status < 500 ? res.status : 502 });
    return data;
  };
  const host = new URL(url).hostname;
  return {
    /** { targets: [{ id, name, host, port, mode, tls, preset, note, credential: { header } | null }], grants: { agent: { target: mode } },
     *    browser: { agent: [target] } } */
    state: () => call("GET", "/_control/state"),
    saveTarget: (t) => call("PUT", `/_control/targets/${t.id}`, t),
    removeTarget: (id) => call("DELETE", `/_control/targets/${id}`),
    /** value null removes the credential. */
    setCredential: (id, { header, format, value }) => call("PUT", `/_control/targets/${id}/credential`, { header, format, value }),
    /** An SSH key for a target: { user, generate: true } makes one here, { user, key } takes a pasted private key. Returns its public half. */
    setSsh: (id, { user, key, generate }) => call("PUT", `/_control/targets/${id}/ssh`, { user, key, generate }),
    removeSsh: (id) => call("DELETE", `/_control/targets/${id}/ssh`),
    /** Forget the device's pinned host key: the next ssh trusts whatever it presents. */
    forgetHostKey: (id) => call("DELETE", `/_control/targets/${id}/host-key`),
    /** Exactly these targets for this agent: { target: "read" | "full" }. browser: the ids its browser may open too
     *  (omitted: those it already had, among these targets). */
    grant: (agent, targets, browser) => call("PUT", `/_control/grants/${agent}`, { targets, ...(browser ? { browser } : {}) }),
    /** What an agent may reach, with the mode it gets (never more than the target's own) and browser: true when its browser may too. */
    forAgent: async (agent) => (await call("GET", `/_control/agents/${agent}`)).targets,
    /** A token for one command: cap "read" or "full". Returns the proxy address for LAN_PROXY, or null when it has no targets. */
    async open(agent, cap, seconds) {
      const r = await call("POST", "/_control/tokens", { agent, cap, seconds });
      return r.token ? { proxy: `http://${agent}:${r.token}@${host}:${LAN_PORT}`, token: r.token, targets: r.targets } : null;
    },
    close: (token) => call("DELETE", `/_control/tokens/${token}`).catch(() => {}),
  };
}

/** What `mode` an agent gets on a target: the lowest of the target's, the grant's and the token's cap. */
const lower = (...modes) => (modes.includes("read") ? "read" : "full");

// ---------- the gateway (only when run as the container's command) ----------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const DIR = process.env.LAN_DIR || "/lan";
  const STORE = path.join(DIR, "lan.json"), KEY_FILE = path.join(DIR, "lan.key");
  const PORT = Number(process.env.LAN_PORT || LAN_PORT);
  const log = (msg) => console.log(`${new Date().toISOString()} [lan] ${msg}`);
  const signed = verifier();

  if (!existsSync(KEY_FILE)) { writeFileSync(KEY_FILE, crypto.randomBytes(32).toString("base64") + "\n", { mode: 0o600, flag: "wx" }); log("created a new key (lan.key)"); }
  const key = Buffer.from(readFileSync(KEY_FILE, "utf8").trim(), "base64");
  if (key.length !== 32) throw new Error(`${KEY_FILE} is not a 32-byte key`);
  const seal = (aad, value) => {
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, iv).setAAD(Buffer.from(aad));
    const data = Buffer.concat([c.update(value, "utf8"), c.final()]);
    return { iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") };
  };
  const unseal = (aad, { iv, tag, data }) => {
    const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64")).setAAD(Buffer.from(aad));
    d.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]).toString("utf8");
  };

  /** { targets: { id: target + credential? { header, format, sealed } }, grants: { agent: { id: mode } }, browser: { agent: [id] } } */
  const db = existsSync(STORE) ? JSON.parse(readFileSync(STORE, "utf8")) : { targets: {}, grants: {} };
  db.browser ??= {};
  /** The browser container, on its own network with this gateway: the only caller that may use a browser grant. */
  const BROWSER_IP = process.env.LAN_BROWSER_IP || "";
  const persist = () => { writeFileSync(`${STORE}.tmp`, JSON.stringify(db, null, 2), { mode: 0o600 }); renameSync(`${STORE}.tmp`, STORE); };
  const tokens = new Map(); // token -> { agent, cap, expires }

  const publicTarget = ({ credential, ssh, ...t }) => ({ ...t, credential: credential ? { header: credential.header, format: credential.format } : null,
    ssh: ssh ? { user: ssh.user, publicKey: ssh.publicKey, fingerprint: ssh.fingerprint, generated: !!ssh.generated } : null });

  // ---------- ssh: keys kept here, ssh run from here ----------
  const KNOWN = path.join(DIR, "known_hosts");
  mkdirSync(KNOWN, { recursive: true, mode: 0o700 });
  const knownHosts = (id) => path.join(KNOWN, id);
  const forgetHost = (id) => rmSync(knownHosts(id), { force: true });
  const TMP = process.env.LAN_TMP || "/tmp";
  /** A private key in a file only this process reads, for as long as fn runs. */
  const withKeyFile = async (privateKey, fn) => {
    const file = path.join(TMP, `k-${crypto.randomBytes(8).toString("hex")}`);
    writeFileSync(file, privateKey.endsWith("\n") ? privateKey : `${privateKey}\n`, { mode: 0o600, flag: "wx" });
    try { return await fn(file); } finally { rmSync(file, { force: true }); }
  };
  const fingerprintOf = (publicKey) => `SHA256:${crypto.createHash("sha256").update(Buffer.from(publicKey.split(/\s+/)[1] ?? "", "base64")).digest("base64").replace(/=+$/, "")}`;
  /** { privateKey, publicKey } made here, or the public half of a pasted key (which must have no passphrase). */
  const sshKeyPair = async (id, pasted) => {
    if (!pasted) {
      const file = path.join(TMP, `g-${crypto.randomBytes(8).toString("hex")}`);
      try {
        execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", `claude-agents-${id}`, "-f", file], { stdio: "ignore", timeout: 10_000 });
        return { privateKey: readFileSync(file, "utf8"), publicKey: readFileSync(`${file}.pub`, "utf8").trim() };
      } finally { rmSync(file, { force: true }); rmSync(`${file}.pub`, { force: true }); }
    }
    const key = String(pasted).replace(/\r\n/g, "\n").trim();
    if (key.length > SSH_KEY_MAX || !/^-----BEGIN [A-Z ]*PRIVATE KEY-----\n[\s\S]+\n-----END [A-Z ]*PRIVATE KEY-----$/.test(key)) fail(400, "Paste the whole private key, from -----BEGIN … PRIVATE KEY----- to -----END … PRIVATE KEY-----");
    if (/ENCRYPTED/.test(key)) fail(400, "That key has a passphrase: use one without, or let the gateway make one");
    const publicKey = await withKeyFile(key, (file) => {
      try { return execFileSync("ssh-keygen", ["-y", "-P", "", "-f", file], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }).trim(); }
      catch { return fail(400, "That isn't a private key ssh can use without a passphrase"); }
    });
    return { privateKey: `${key}\n`, publicKey: `${publicKey.split(/\s+/).slice(0, 2).join(" ")} claude-agents-${id}` };
  };

  // ssh won't start for a user id with no passwd entry (AGENT_UID other than the image's 1000): give it one with nss_wrapper.
  const sshEnv = { PATH: process.env.PATH, HOME: TMP, LANG: "C.UTF-8" };
  try { execFileSync("getent", ["passwd", String(process.getuid())], { stdio: "ignore" }); }
  catch {
    const lib = ["/usr/lib/x86_64-linux-gnu", "/usr/lib/aarch64-linux-gnu", "/usr/lib"].map((d) => `${d}/libnss_wrapper.so`).find(existsSync);
    if (lib) {
      writeFileSync(path.join(TMP, "passwd"), `agent:x:${process.getuid()}:${process.getgid()}:agent:${TMP}:/bin/sh\n`);
      writeFileSync(path.join(TMP, "group"), `agent:x:${process.getgid()}:\n`);
      Object.assign(sshEnv, { LD_PRELOAD: lib, NSS_WRAPPER_PASSWD: path.join(TMP, "passwd"), NSS_WRAPPER_GROUP: path.join(TMP, "group") });
    } else log(`uid ${process.getuid()} has no passwd entry and nss_wrapper is missing: lan-ssh won't work`);
  }

  // ---------- ssh passwords: vault logins for a device, granted to an agent ----------
  const LOGINS_DIR = process.env.LAN_LOGINS_DIR || "/run/lan-logins";
  const LOGIN_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
  /** The vault logins an agent may use on a device (same IP): [{ name, value }]. Values stay in this process. */
  const deviceLogins = (agent, host) => {
    let all = {};
    try { all = JSON.parse(readFileSync(path.join(LOGINS_DIR, `${agent}.json`), "utf8")); } catch { return []; }
    return Object.entries(all).filter(([n, l]) => LOGIN_RE.test(n) && l?.host === host && typeof l.value === "string").map(([name, l]) => ({ name, value: l.value }));
  };
  const ASKPASS = process.env.LAN_ASKPASS || "/usr/local/bin/lan-askpass";

  /**
   * Runs one command on a target over ssh, with its key or, given `password` ({ user, value }), a vault password.
   * Given `sudo` ({ value }), runs it with sudo on the device and answers sudo's password prompt with that value.
   * Resolves { exitCode, output, timedOut, seconds, sudoAsked }.
   */
  const runSsh = (target, command, seconds, password = null, sudo = null) => {
    if (sudo) {
      // A prompt nobody can guess, so the value goes to sudo's own prompt and nowhere else. -k: sudo always asks (a
      // cached sudo session would otherwise leave the value unread on stdin); the command itself gets /dev/null.
      sudo = { ...sudo, prompt: `[lan-ssh sudo ${crypto.randomBytes(8).toString("hex")}]` };
      command = `sudo -k -S -p '${sudo.prompt}' -- sh -c ${shQuote(`exec </dev/null; ${command}`)}`;
    }
    return password
      ? sshProcess(target, command, seconds, ["-l", password.user, "-o", "BatchMode=no", "-o", "PubkeyAuthentication=no",
        "-o", "PreferredAuthentications=password,keyboard-interactive", "-o", "NumberOfPasswordPrompts=1"],
      // ssh asks lan-askpass, which prints this; there's no terminal and nothing else to ask (host keys: accept-new)
      { SSH_ASKPASS: ASKPASS, SSH_ASKPASS_REQUIRE: "force", DISPLAY: ":0", LAN_SSH_PASSWORD: password.value }, sudo)
      : withKeyFile(unseal(`${target.id}:ssh`, target.ssh.sealed), (keyFile) => sshProcess(target, command, seconds,
        ["-i", keyFile, "-l", target.ssh.user, "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes"], {}, sudo));
  };
  const shQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
  const sshProcess = (target, command, seconds, auth, extraEnv = {}, sudo = null) => new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("ssh", ["-F", "/dev/null", "-p", String(target.port), ...auth,
      "-o", "StrictHostKeyChecking=accept-new", "-o", `UserKnownHostsFile=${knownHosts(target.id)}`,
      "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "LogLevel=ERROR", "-T", target.host, "--", command],
    { stdio: [sudo ? "pipe" : "ignore", "pipe", "pipe"], env: { ...sshEnv, ...extraEnv }, detached: true }); // detached: no terminal to ask on
    let out = Buffer.alloc(0), dropped = 0, timedOut = false;
    const keep = (c) => { const room = SSH_OUTPUT_MAX - out.length; if (room > 0) out = Buffer.concat([out, c.subarray(0, room)]); dropped += Math.max(0, c.length - room); };
    child.stdout.on("data", keep); child.stderr.on("data", keep);
    // sudo -S writes its prompt to stderr: the value is sent once, when it asks, and stdin closes with it. Never on a
    // second ask (a command running as root could print the prompt itself to fish for it). No ask (NOPASSWD): never sent.
    let sudoAsked = false, tail = "";
    if (sudo) {
      child.stdin.on("error", () => {}); // the device may close it first
      child.stderr.on("data", (c) => {
        if (sudoAsked) return;
        const s = tail + c.toString("latin1");
        if (s.includes(sudo.prompt)) { sudoAsked = true; child.stdin.end(`${sudo.value}\n`); }
        tail = s.slice(-sudo.prompt.length);
      });
    }
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, seconds * 1000);
    child.on("error", (e) => { clearTimeout(timer); resolve({ exitCode: 255, output: `lan-ssh: can't run ssh here: ${e.message}`, timedOut, seconds: 0 }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const text = out.toString("utf8");
      resolve({ exitCode: code ?? 255, output: (sudo ? text.split(sudo.prompt).join("") : text) + (dropped ? `\n… (${dropped} bytes left out)` : ""),
        timedOut, seconds: Math.round((Date.now() - started) / 100) / 10, sudoAsked });
    });
  });
  /** The targets an agent may reach now, with its mode on each. */
  const reach = (agent, cap = "full") => Object.entries(db.grants[agent] ?? {})
    .filter(([id]) => db.targets[id])
    .map(([id, mode]) => ({ ...db.targets[id], mode: lower(db.targets[id].mode, mode, cap), browser: (db.browser[agent] ?? []).includes(id) }));
  /** What each agent's browser may open: { agent: [{ host, port, tls, mode }] }. Names and addresses only. */
  const browserReach = () => Object.fromEntries(Object.keys(db.browser).map((agent) => [agent,
    reach(agent).filter((t) => t.browser).map(({ host, port, tls, mode }) => ({ host, port, tls: !!tls, mode }))]).filter(([, l]) => l.length));
  /** host:port pairs the firewall must open for this container: every target granted to at least one agent. */
  const allowList = () => [...new Set(Object.values(db.grants).flatMap((g) => Object.keys(g)).filter((id) => db.targets[id])
    .map((id) => `${db.targets[id].host}:${db.targets[id].port}`))].sort();
  const credentialValue = (t) => {
    const c = t.credential;
    if (!c) return null;
    const v = unseal(`${t.id}:${c.header}`, c.sealed);
    return c.format.replace("{base64}", Buffer.from(v).toString("base64")).replace("{}", v);
  };

  const send = (res, code, body) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
  const readRaw = (req, limit = 32 * 1024) => new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error("too large"), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });

  // ---------- control API: the app only, signed ----------
  async function control(req, res, url) {
    const raw = await readRaw(req);
    if (!signed(req, raw)) { log(`refused an unsigned control call from ${req.socket.remoteAddress}`); return send(res, 403, { error: "only the app" }); }
    let body = {};
    if (raw) { try { body = JSON.parse(raw); } catch { fail(400, "invalid JSON"); } }
    const p = url.pathname.slice("/_control".length);
    let m;
    if (req.method === "GET" && p === "/state") {
      return send(res, 200, { targets: Object.values(db.targets).map(publicTarget).sort((a, b) => a.name.localeCompare(b.name)), grants: db.grants, browser: db.browser });
    }
    if (req.method === "GET" && (m = p.match(/^\/agents\/([a-z0-9-]+)$/))) {
      return send(res, 200, { targets: reach(m[1]).map(publicTarget) });
    }
    if (req.method === "PUT" && (m = p.match(/^\/targets\/([a-z0-9-]+)$/))) {
      const { errors, target } = validateTarget({ ...body, id: m[1] });
      if (errors.length) fail(400, errors.join("; "));
      if (!db.targets[target.id] && Object.keys(db.targets).length >= MAX_TARGETS) fail(400, `At most ${MAX_TARGETS} targets`);
      const before = db.targets[target.id];
      // Moving a target elsewhere drops its credential: it was given for that device.
      const keep = before && before.host === target.host && before.port === target.port ? before.credential : undefined;
      // Its SSH key is who we are, not a secret of the device, so it stays; the pinned host key belongs to the old address.
      db.targets[target.id] = { ...target, ...(keep ? { credential: keep } : {}), ...(before?.ssh ? { ssh: before.ssh } : {}) };
      if (before && (before.host !== target.host || before.port !== target.port)) forgetHost(target.id);
      persist();
      log(`target ${target.id}: ${target.host}:${target.port} (${target.mode}${target.tls ? ", https" : ""})${before && !keep && before.credential ? ", credential dropped (new address)" : ""}`);
      return send(res, 200, { target: publicTarget(db.targets[target.id]) });
    }
    if (req.method === "DELETE" && (m = p.match(/^\/targets\/([a-z0-9-]+)$/))) {
      if (!db.targets[m[1]]) fail(404, `No target ${m[1]}`);
      delete db.targets[m[1]];
      for (const g of Object.values(db.grants)) delete g[m[1]];
      for (const [a, l] of Object.entries(db.browser)) { const left = l.filter((id) => id !== m[1]); if (left.length) db.browser[a] = left; else delete db.browser[a]; }
      forgetHost(m[1]);
      persist(); log(`target ${m[1]} removed`);
      return send(res, 200, { ok: true });
    }
    if (req.method === "PUT" && (m = p.match(/^\/targets\/([a-z0-9-]+)\/ssh$/))) {
      const t = db.targets[m[1]] ?? fail(404, `No target ${m[1]}`);
      const user = String(body.user ?? "").trim();
      if (!SSH_USER_RE.test(user)) fail(400, "user: the account to sign in as on the device, e.g. admin");
      const { privateKey, publicKey } = await sshKeyPair(t.id, body.generate ? null : body.key ?? fail(400, "Paste a private key, or generate one"));
      t.ssh = { user, publicKey, fingerprint: fingerprintOf(publicKey), generated: !!body.generate, sealed: seal(`${t.id}:ssh`, privateKey), updatedAt: new Date().toISOString() };
      forgetHost(t.id); // a new key: trust the device's host key again on first use
      persist(); log(`target ${t.id}: ssh key ${body.generate ? "generated" : "saved"} for ${user} (${t.ssh.fingerprint})`);
      return send(res, 200, { target: publicTarget(t) });
    }
    if (req.method === "DELETE" && (m = p.match(/^\/targets\/([a-z0-9-]+)\/host-key$/))) {
      const t = db.targets[m[1]] ?? fail(404, `No target ${m[1]}`);
      forgetHost(t.id); log(`target ${t.id}: host key forgotten, trusted again on the next ssh`);
      return send(res, 200, { target: publicTarget(t) });
    }
    if (req.method === "DELETE" && (m = p.match(/^\/targets\/([a-z0-9-]+)\/ssh$/))) {
      const t = db.targets[m[1]] ?? fail(404, `No target ${m[1]}`);
      delete t.ssh; forgetHost(t.id);
      persist(); log(`target ${t.id}: ssh key removed`);
      return send(res, 200, { target: publicTarget(t) });
    }
    if (req.method === "PUT" && (m = p.match(/^\/targets\/([a-z0-9-]+)\/credential$/))) {
      const t = db.targets[m[1]] ?? fail(404, `No target ${m[1]}`);
      if (body.value == null || body.value === "") { delete t.credential; persist(); log(`target ${t.id}: credential removed`); return send(res, 200, { target: publicTarget(t) }); }
      const header = String(body.header ?? ""), format = String(body.format ?? "{}"), value = String(body.value);
      if (!HEADER_RE.test(header) || /^(host|connection|content-length|transfer-encoding|proxy-.*)$/i.test(header)) fail(400, "header: a header name, e.g. Authorization or X-Api-Key");
      if (!format.includes("{}") && !format.includes("{base64}")) fail(400, "format: must contain {} or {base64} where the value goes");
      if (format.length > 100 || /[\r\n]/.test(format)) fail(400, "format: one short line");
      if (value.length > MAX_SECRET || /[\r\n]/.test(value)) fail(400, "The value is too long or has a line break");
      t.credential = { header, format, sealed: seal(`${t.id}:${header}`, value), updatedAt: new Date().toISOString() };
      persist(); log(`target ${t.id}: credential saved (${header})`);
      return send(res, 200, { target: publicTarget(t) });
    }
    if (req.method === "PUT" && (m = p.match(/^\/grants\/([a-z0-9-]+)$/))) {
      if (!AGENT_RE.test(m[1])) fail(400, "unknown agent");
      const wanted = body.targets && typeof body.targets === "object" ? body.targets : {};
      const next = {};
      for (const [id, mode] of Object.entries(wanted)) {
        if (!db.targets[id]) fail(400, `No target ${id}`);
        if (!LAN_MODES.includes(mode)) fail(400, 'mode: "read" or "full"');
        next[id] = mode;
      }
      if (Object.keys(next).length) db.grants[m[1]] = next; else delete db.grants[m[1]];
      const browser = (Array.isArray(body.browser) ? body.browser.map(String) : db.browser[m[1]] ?? []).filter((id) => next[id]);
      if (browser.length) db.browser[m[1]] = [...new Set(browser)]; else delete db.browser[m[1]];
      persist(); log(`${m[1]} may reach ${Object.entries(next).map(([id, md]) => `${id} (${md}${browser.includes(id) ? ", browser too" : ""})`).join(", ") || "nothing"}`);
      return send(res, 200, { targets: reach(m[1]).map(publicTarget) });
    }
    if (req.method === "POST" && p === "/tokens") {
      const agent = String(body.agent ?? ""), cap = LAN_MODES.includes(body.cap) ? body.cap : "read";
      if (!AGENT_RE.test(agent)) fail(400, "unknown agent");
      const targets = reach(agent, cap);
      if (!targets.length) return send(res, 200, { token: null, targets: [] });
      const seconds = Math.min(Math.max(Number(body.seconds) || 120, 1), 3600);
      const token = crypto.randomBytes(24).toString("base64url");
      for (const [t, v] of tokens) if (v.expires < Date.now()) tokens.delete(t);
      tokens.set(token, { agent, cap, expires: Date.now() + seconds * 1000 });
      return send(res, 200, { token, targets: targets.map(publicTarget) });
    }
    if (req.method === "DELETE" && (m = p.match(/^\/tokens\/([A-Za-z0-9_-]+)$/))) {
      tokens.delete(m[1]);
      return send(res, 200, { ok: true });
    }
    fail(404, "not found");
  }

  // ---------- the proxy: a command's way to its agent's targets ----------
  /** The command's token from Proxy-Authorization ("agent:token"), or null. */
  function who(req) {
    const m = String(req.headers["proxy-authorization"] ?? "").match(/^Basic\s+([A-Za-z0-9+/=]+)$/i);
    if (!m) return null;
    const [agent, token] = Buffer.from(m[1], "base64").toString().split(":");
    // An agent's browser: only from the browser container's own address, and only its browser grants.
    if (token === "browser") return BROWSER_IP && fromAddress(req) === BROWSER_IP && AGENT_RE.test(agent ?? "") ? { agent, cap: "full", browser: true } : null;
    const t = tokens.get(token ?? "");
    if (!t || t.agent !== agent) return null;
    if (t.expires < Date.now()) { tokens.delete(token); return null; }
    return t;
  }
  const fromAddress = (req) => String(req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
  const findTarget = (t, host, port) => reach(t.agent, t.cap).find((x) => x.host === host && x.port === port && (!t.browser || x.browser));
  const deny = (res, code, message) => {
    res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8", ...(code === 407 ? { "Proxy-Authenticate": 'Basic realm="lan"' } : {}) });
    res.end(`${message}\n`);
  };

  async function proxyHttp(req, res, url) {
    const t = who(req);
    if (!t) return deny(res, 407, "lan: no valid LAN access for this command (run it with `lan <command>`, and only for a command approved with LAN access)");
    const host = url.hostname, port = Number(url.port || 80);
    const target = findTarget(t, host, port);
    if (!target) { log(`${t.agent}: refused ${req.method} ${host}:${port} (not one of its targets)`); return deny(res, 403, `lan: ${host}:${port} isn't one of ${t.agent}'s targets`); }
    if (target.mode === "read" && !READ_METHODS.has(req.method)) {
      log(`${t.agent}: refused ${req.method} ${target.id}${url.pathname} (read-only)`);
      return deny(res, 403, `lan: ${target.name} is read-only for ${t.agent}: only GET, HEAD and OPTIONS`);
    }
    const headers = { ...req.headers };
    for (const h of ["proxy-authorization", "proxy-connection", "connection", "keep-alive"]) delete headers[h];
    let cred = null;
    try { cred = credentialValue(target); } catch { log(`target ${target.id}: can't decrypt its credential (wrong lan.key?)`); }
    if (target.credential) {
      for (const k of Object.keys(headers)) if (k.toLowerCase() === target.credential.header.toLowerCase()) delete headers[k];
      if (cred) headers[target.credential.header.toLowerCase()] = cred;
    }
    headers.host = `${host}:${port}`;
    const lib = target.tls ? https : http;
    const started = Date.now();
    const up = lib.request({ host, port, method: req.method, path: `${url.pathname}${url.search}`, headers,
      ...(target.tls ? { rejectUnauthorized: !!target.verifyTls, servername: undefined } : {}), timeout: 60_000 }, (r) => {
      const out = { ...r.headers };
      delete out.connection; delete out["keep-alive"];
      // The browser talks http:// to a device the gateway reaches over https: keep its redirects and cookies on http://.
      if (t.browser && target.tls) {
        const self = new RegExp(`^https://${host.replace(/\./g, "\\.")}(:${port})?(?=/|$)`, "i");
        if (out.location) out.location = String(out.location).replace(self, `http://${host}:${port}`);
        if (out["set-cookie"]) out["set-cookie"] = [out["set-cookie"]].flat().map((c) => c.replace(/;\s*secure\b/gi, ""));
      }
      res.writeHead(r.statusCode ?? 502, out);
      r.pipe(res);
      r.on("end", () => log(`${t.agent}${t.browser ? " (browser)" : ""}: ${req.method} ${target.id}${url.pathname} → ${r.statusCode} (${Date.now() - started} ms${cred ? ", with its credential" : ""})`));
    });
    up.on("timeout", () => up.destroy(new Error("timed out")));
    up.on("error", (e) => { log(`${t.agent}: ${req.method} ${target.id}${url.pathname} failed: ${e.message}`); if (!res.headersSent) deny(res, 502, `lan: ${target.name} didn't answer: ${e.message}`); else res.destroy(); });
    req.pipe(up);
  }

  function tunnel(req, socket, head) {
    const bad = (code, text) => { socket.end(`HTTP/1.1 ${code} ${text}\r\nContent-Type: text/plain\r\n${code === 407 ? 'Proxy-Authenticate: Basic realm="lan"\r\n' : ""}\r\nlan: ${text}\n`); };
    const t = who(req);
    if (!t) return bad(407, "no valid LAN access for this command");
    // A browser opens devices as http:// (the gateway does the https): it never needs a tunnel.
    if (t.browser) return bad(403, "a browser opens devices as http://IP:PORT/, without tunnels");
    const [host, p] = String(req.url ?? "").split(":");
    const port = Number(p);
    const target = findTarget(t, host, port);
    if (!target) { log(`${t.agent}: refused a tunnel to ${req.url} (not one of its targets)`); return bad(403, `${req.url} isn't one of ${t.agent}'s targets`); }
    if (target.mode === "read") {
      log(`${t.agent}: refused a tunnel to ${target.id} (read-only)`);
      return bad(403, `${target.name} is read-only for ${t.agent}: use http:// requests (the gateway speaks https to it), no tunnels`);
    }
    const up = net.connect({ host, port, timeout: 15_000 }, () => {
      socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
      if (head?.length) up.write(head);
      up.setTimeout(0);
      up.pipe(socket); socket.pipe(up);
      log(`${t.agent}: tunnel to ${target.id} (${host}:${port}) opened`);
    });
    up.on("timeout", () => up.destroy(new Error("timed out")));
    up.on("error", (e) => { log(`${t.agent}: tunnel to ${target.id} failed: ${e.message}`); bad(502, `${target.name} didn't answer: ${e.message}`); });
    socket.on("error", () => up.destroy());
    up.on("close", () => socket.destroy());
  }

  /**
   * POST /ssh from `lan-ssh` in a command: { target: id | IP | IP:port, command, user?, login?, sudo? }. Only with the
   * command's token, only a target of its agent with full access, and an SSH key or a vault login for that device granted
   * to the agent (`login` names it; without one, the key, else the only such login). `sudo` names a vault login for that
   * device too: the command runs with sudo there, and the gateway answers sudo's prompt with it. Runs ssh here; the
   * answer is the output, never the key or a password.
   */
  async function sshCommand(req, res) {
    const t = who(req);
    // 403, not 407: this isn't a proxy request, and fetch() in lan-ssh doesn't hand a 407 back
    if (!t || t.browser) return send(res, 403, { error: "this command has no access to your network (run it as an approved command with network access)" });
    let body;
    try { body = JSON.parse(await readRaw(req, 16 * 1024) || "{}"); } catch { return send(res, 400, { error: "invalid request" }); }
    const want = String(body.target ?? "").trim(), command = String(body.command ?? "");
    const loginName = String(body.login ?? "").trim(), userWanted = String(body.user ?? "").trim(), sudoName = String(body.sudo ?? "").trim();
    if (!command.trim() || command.length > SSH_COMMAND_MAX) return send(res, 400, { error: `a command is 1 to ${SSH_COMMAND_MAX} characters` });
    if (loginName && !LOGIN_RE.test(loginName)) return send(res, 400, { error: "--login takes a login's NAME, e.g. ROUTER_PASSWORD" });
    if (sudoName && !LOGIN_RE.test(sudoName)) return send(res, 400, { error: "--sudo takes a login's NAME, e.g. ROUTER_PASSWORD" });
    if (userWanted && !SSH_USER_RE.test(userWanted)) return send(res, 400, { error: "-l takes a user name, e.g. admin" });
    const all = reach(t.agent, t.cap);
    const target = all.find((x) => x.id === want || `${x.host}:${x.port}` === want)
      ?? all.filter((x) => x.host === want).find((x) => x.ssh || x.port === 22) ?? all.find((x) => x.host === want && x.mode === "full");
    if (!target) { log(`${t.agent}: refused ssh to ${want.slice(0, 60)} (not one of its targets)`); return send(res, 403, { error: `${want} isn't one of ${t.agent}'s devices` }); }
    if (target.mode !== "full") { log(`${t.agent}: refused ssh to ${target.id} (read-only)`); return send(res, 403, { error: `${target.name} is read-only for ${t.agent}: ssh needs full access` }); }
    // A password from the vault: asked for by name, or the only one there is when the target has no key.
    let password = null;
    if (loginName || !target.ssh) {
      const logins = deviceLogins(t.agent, target.host);
      const login = loginName ? logins.find((l) => l.name === loginName) : logins.length === 1 ? logins[0] : null;
      if (loginName && !login) {
        log(`${t.agent}: refused ssh to ${target.id} with ${loginName} (not a login of ${target.host} granted to it)`);
        return send(res, 403, { error: `${loginName} isn't a vault login for ${target.host} that ${t.agent} may use. ` +
          `Its site in the vault must be this device (http://${target.host}:…), and the human grants it to you there` });
      }
      if (!login && logins.length > 1) return send(res, 400, { error: `${target.name} has several vault logins you may use (${logins.map((l) => l.name).join(", ")}): pick one with --login NAME` });
      if (!login) return send(res, 400, { error: `${target.name} has no SSH key and no vault login granted to you for ${target.host}: ` +
        "call request_device_key with kind \"ssh\", or ask the human to save its password in the vault for this device and grant it to you" });
      const user = userWanted || target.ssh?.user;
      if (!user) return send(res, 400, { error: `Say which user to sign in as with the password: lan-ssh -l <user> --login ${login.name} ${target.id} <command>` });
      password = { user, name: login.name, value: login.value };
    }
    // sudo's password: a vault login for this device granted to the agent, asked for by name (often the same as --login).
    let sudo = null;
    if (sudoName) {
      const login = deviceLogins(t.agent, target.host).find((l) => l.name === sudoName);
      if (!login) {
        log(`${t.agent}: refused sudo on ${target.id} with ${sudoName} (not a login of ${target.host} granted to it)`);
        return send(res, 403, { error: `${sudoName} isn't a vault login for ${target.host} that ${t.agent} may use. ` +
          `Its site in the vault must be this device (http://${target.host}:…), and the human grants it to you there` });
      }
      sudo = { name: login.name, value: login.value };
    }
    const signedInAs = password ? password.user : target.ssh.user;
    const seconds = Math.max(1, Math.min(SSH_TIMEOUT_MAX, Math.floor((t.expires - Date.now()) / 1000) - 5));
    const r = await runSsh(target, command, seconds, password, sudo);
    const sudoAsked = r.sudoAsked; delete r.sudoAsked;
    if (password && r.exitCode === 255 && /Permission denied/.test(r.output)) {
      r.output = `${r.output}\nlan-ssh: ${target.name} refused ${password.user} with the password in ${password.name}. Don't retry: tell the human ` +
        "(the user, or the saved password, may be wrong; ssh may also be set to keys only on the device).\n";
    }
    if (sudo && r.exitCode === 127 && /sudo: (command )?not found|sudo: No such file/.test(r.output)) {
      r.output = `${r.output}\nlan-ssh: ${target.name} has no sudo. Don't retry with --sudo: tell the human ` +
        "(if root may sign in over ssh, they can save root's password in the vault for this device: lan-ssh -l root --login NAME …).\n";
    } else if (sudo && r.exitCode === 1 && /incorrect password|Sorry, try again|no password was provided|is not in the sudoers|not allowed to (run|execute)|may not run sudo/.test(r.output)) {
      r.output = `${r.output}\nlan-ssh: sudo on ${target.name} refused ${signedInAs}${sudoAsked ? ` with the password in ${sudo.name}` : ""}. Don't retry: tell the human ` +
        `(the saved password may be wrong, or ${signedInAs} may not be allowed to use sudo there).\n`;
    }
    if (r.exitCode === 255 && /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/.test(r.output)) {
      r.output = `${r.output}\nlan-ssh: ${target.name} answered with a different host key than the first time. Don't retry: tell the human. ` +
        "If they changed the device, they tap \"Trust its new host key\" for it in your details (What it can reach).\n";
    }
    log(`${t.agent}: ssh ${target.id} as ${password ? `${password.user} (password ${password.name})` : target.ssh.user}${sudo ? ` with sudo (password ${sudo.name})` : ""}: ${command.replace(/\s+/g, " ").slice(0, 200)} → ${r.timedOut ? "timed out" : `exit ${r.exitCode}`} (${r.seconds}s)`);
    send(res, 200, r);
  }

  /** The firewall (host network) asks for the list of host:port pairs to open; it reaches us from our network's gateway. */
  function fromHost(req) {
    const from = String(req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
    try {
      const route = readFileSync("/proc/net/route", "utf8").split("\n").slice(1).map((l) => l.trim().split(/\s+/)).find((c) => c[1] === "00000000");
      const gw = route && Buffer.from(route[2], "hex").reverse().join(".");
      return !!gw && gw === from;
    } catch { return false; }
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (/^https?:\/\//i.test(req.url ?? "")) return await proxyHttp(req, res, new URL(req.url));
      const url = new URL(req.url, "http://x");
      if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });
      if (req.method === "POST" && url.pathname === "/ssh") return await sshCommand(req, res);
      // The browser's guard asks which devices each agent's browser may open (addresses only, from its address only).
      if (req.method === "GET" && url.pathname === "/browser/devices") {
        if (!BROWSER_IP || fromAddress(req) !== BROWSER_IP) return send(res, 403, { error: "only the browser" });
        return send(res, 200, { agents: browserReach() });
      }
      if (req.method === "GET" && url.pathname === "/allow") {
        if (!fromHost(req)) return send(res, 403, { error: "only the firewall" });
        res.writeHead(200, { "Content-Type": "text/plain" });
        return res.end(allowList().map((a) => `${a}\n`).join(""));
      }
      if (url.pathname.startsWith("/_control/")) return await control(req, res, url);
      send(res, 404, { error: "not found" });
    } catch (e) {
      if (!res.headersSent) send(res, e.code >= 400 && e.code < 500 ? e.code : 500, { error: e.code >= 400 && e.code < 500 ? e.message : "gateway error" });
      if (!(e.code >= 400 && e.code < 500)) log(`ERROR ${req.method} ${req.url?.slice(0, 200)}: ${e.message}`);
    }
  });
  server.on("connect", tunnel);
  server.listen(PORT, "0.0.0.0", () => log(`LAN gateway on port ${PORT}: ${Object.keys(db.targets).length} target(s), allowed out to ${allowList().join(", ") || "nothing"}`));
}
