// In front of the browsers, in the browser container: agents reach a browser only through here.
//
// Each agent gets its own browser: a Playwright MCP server on 127.0.0.1 with its own profile
// (/profiles/<agent>: cookies, sign-ins) and only the logins granted to it (the vault's agents/<agent>.env).
// One agent can't use another's sign-ins, and never holds a login it wasn't granted. A browser starts on
// the agent's first call, restarts when its logins or the sites change (Playwright reads them only at
// startup), and stops after BROWSER_IDLE_MINUTES without use. At most BROWSER_MAX_AGENTS run at once.
// The app names the agent in a header it sets on the connection (X-Agent); a call without one is refused.
//
// It also removes the tools that would let an agent read saved logins:
//   - browser_run_code_unsafe: runs code in the server's Node process, which can read the logins file
//   - browser_evaluate: JavaScript in the page can read a password the browser typed into a field
//   - browser_network_request(s): a password sent by a form can show there URL-encoded, past the redaction
// Playwright has no option to turn tools off, so they're dropped from tools/list and refused in tools/call.
// And a call that types the NAME of a login not granted to the agent is refused with a clear answer
// (its browser doesn't hold that login, so it would type the name itself).
//
// The live view: each browser also listens for the DevTools protocol on a 127.0.0.1 port only the guard reaches.
// The app (with the chat login) gets a picture of the agent's page from /live/<agent>/shot, and sends the
// human's clicks and typing to /live/<agent>/input when they take over (e.g. a captcha the agent can't pass).
//
// Your network: an agent's browser can open the devices you let it reach from its browser (request_network_access with browser, approved in the chat), and nothing
// else there. The guard asks the LAN gateway for that list (LAN_PROXY_URL, on a network only the gateway and this
// container share), and gives each browser a proxy setting that sends exactly those addresses to a small forwarder here,
// which hands them to the gateway in the agent's name. The gateway checks the device, the mode and logs each request.
// Every other address goes out directly, as before; navigation.cjs still refuses every other private address.
//
// Started as: node mcp-guard.mjs <Playwright MCP options for every browser>

import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync, existsSync, writeFileSync } from "node:fs";

const BLOCKED = new Set(["browser_run_code_unsafe", "browser_evaluate", "browser_network_request", "browser_network_requests"]);
const PORT = Number(process.env.MCP_GUARD_PORT || 8931);
const SECRETS = process.env.MCP_GUARD_SECRETS || "/run/browser-secrets";
const PROFILES = process.env.MCP_GUARD_PROFILES || "/profiles";
const SHOTS = process.env.MCP_GUARD_SHOTS || "/shots";
const CLI = process.env.MCP_GUARD_CLI || "/app/cli.js";
const MAX_BROWSERS = Number(process.env.BROWSER_MAX_AGENTS || 3);
const IDLE_MS = Number(process.env.BROWSER_IDLE_MINUTES || 30) * 60_000;
const FIRST_PORT = 8940;
const AGENT_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/; // AGENT_NAME_RE in app/logins.mjs: also a safe folder name
const SERVER_ARGS = process.argv.slice(2);
const log = (msg) => console.log(`${new Date().toISOString()} [guard] ${msg}`);

const read = (f) => { try { return readFileSync(f, "utf8"); } catch { return ""; } };
const loginsFile = (agent) => `${SECRETS}/agents/${agent}.env`;
/** The sites pages may open: the stack's BROWSER_ALLOWED_ORIGINS plus those you allowed in the chat. */
const sites = () => [process.env.BROWSER_ALLOWED_ORIGINS ?? "", ...read(`${SECRETS}/origins`).split("\n")]
  .flatMap((s) => s.split(";")).map((s) => s.trim()).filter(Boolean).join(";");
/** Changes when the agent's logins, the sites or its devices do. */
const stamp = (agent) => crypto.createHash("sha256").update(`${read(loginsFile(agent))}\0${sites()}\0${JSON.stringify(devicesOf(agent))}`).digest("hex");

// ---------- devices on your network (the LAN gateway) ----------

const LAN_PROXY = process.env.LAN_PROXY_URL || "";
let lanDevices = {}; // agent -> [{ host, port, tls, mode }]
const devicesOf = (agent) => lanDevices[agent] ?? [];
async function pollDevices() {
  if (!LAN_PROXY) return;
  try {
    const r = await fetch(`${LAN_PROXY}/browser/devices`, { signal: AbortSignal.timeout(3000) });
    if (r.ok) lanDevices = (await r.json()).agents ?? {}; // otherwise the last list stays
  } catch { /* the gateway is restarting: keep the last list */ }
}
if (LAN_PROXY) { await pollDevices(); setInterval(pollDevices, 5000).unref(); }

/**
 * A forwarder on 127.0.0.1 for one agent's browser: what its proxy setting sends here (only its devices' addresses)
 * goes to the gateway with the agent's name. The gateway believes that name only from this container's address.
 */
function lanForwarder(agent, port) {
  const gw = new URL(LAN_PROXY);
  const auth = `Basic ${Buffer.from(`${agent}:browser`).toString("base64")}`;
  const via = { host: gw.hostname, port: Number(gw.port || 80) };
  const server = http.createServer((req, res) => {
    const up = http.request({ ...via, method: req.method, path: req.url, headers: { ...req.headers, "proxy-authorization": auth } }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res);
    });
    up.on("error", (e) => { if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" }); res.end(`lan: ${e.message}\n`); });
    req.pipe(up);
  });
  server.on("connect", (req, sock, head) => {
    const up = http.request({ ...via, method: "CONNECT", path: req.url, headers: { host: req.url, "proxy-authorization": auth } });
    up.on("connect", (r, upSock, upHead) => {
      sock.write(`HTTP/1.1 ${r.statusCode} ${r.statusMessage ?? ""}\r\n\r\n`);
      if (r.statusCode !== 200) { sock.end(); upSock.destroy(); return; }
      if (upHead?.length) sock.write(upHead);
      if (head?.length) upSock.write(head);
      upSock.pipe(sock); sock.pipe(upSock);
      upSock.on("error", () => sock.destroy()); sock.on("error", () => upSock.destroy());
    });
    up.on("response", (r) => { sock.end(`HTTP/1.1 ${r.statusCode} ${r.statusMessage ?? ""}\r\n\r\n`); r.resume(); });
    up.on("error", () => sock.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
    up.end();
  });
  return new Promise((resolve, reject) => server.once("error", reject).listen(port, "127.0.0.1", () => resolve(server)));
}

/** A proxy setting (PAC) that sends only these hosts to the forwarder; everything else goes out directly. */
function pacFor(devices, port) {
  const hosts = JSON.stringify([...new Set(devices.map((d) => d.host))]);
  const pac = `function FindProxyForURL(url, host) { return ${hosts}.indexOf(host) >= 0 ? "PROXY 127.0.0.1:${port}" : "DIRECT"; }`;
  return `data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(pac).toString("base64")}`;
}

// ---------- logins ----------

/** { NAME: [agent] } for every login the vault knows, read on each call so a new grant applies at once. */
const grants = () => { try { return JSON.parse(readFileSync(`${SECRETS}/grants.json`, "utf8")); } catch { return {}; } };
const strings = (v) => typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(strings) : [];
/** The login names in a call that the agent may not type. */
const notGranted = (args, agent) => {
  const g = grants();
  return [...new Set(strings(args).map((s) => s.trim()).filter((s) => Object.hasOwn(g, s) && !g[s].includes(agent)))];
};

// ---------- one browser per agent ----------

/** agent → { port, cdp, stamp, used, open, stopped, child, ready: Promise<port>, exited: Promise, live } */
const browsers = new Map();

const portFree = (port) => new Promise((resolve) => {
  const s = net.createServer().once("error", () => resolve(false));
  s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
});
async function freePort() {
  const taken = new Set([...browsers.values()].flatMap((b) => [b.port, b.cdp, b.lanPort]));
  for (let p = FIRST_PORT; p < FIRST_PORT + 100; p++) if (!taken.has(p) && await portFree(p)) return p;
  throw new Error("no free port");
}
/** Resolves once the server answers on port; rejects if it exits or takes longer than ms. */
async function answers(b, ms = 30_000) {
  for (const until = Date.now() + ms; Date.now() < until;) {
    if (b.child.exitCode !== null || b.child.signalCode) throw new Error("the browser exited while starting");
    const up = await new Promise((resolve) => http.get({ host: "127.0.0.1", port: b.port, path: "/", timeout: 1000 },
      (r) => { r.resume(); resolve(true); }).on("error", () => resolve(false)).on("timeout", function () { this.destroy(); }));
    if (up) return b.port;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("the browser took too long to start");
}

function start(agent, after) {
  const b = { port: 0, stamp: stamp(agent), used: Date.now(), open: 0 };
  b.ready = (async () => {
    await after; // the profile can be opened by one browser at a time
    b.port = await freePort();
    b.cdp = await freePort();
    if (b.stopped) throw new Error("stopped before it started");
    const file = loginsFile(agent);
    const logins = read(file).split("\n").filter(Boolean).length;
    // The DevTools port for the live view, on 127.0.0.1 only (Playwright keeps its own pipe to the browser).
    const config = `/tmp/guard-${agent}.json`;
    const devices = devicesOf(agent);
    const args = [`--remote-debugging-port=${b.cdp}`, "--remote-debugging-address=127.0.0.1"];
    if (devices.length) {
      b.lanPort = await freePort();
      b.lan = await lanForwarder(agent, b.lanPort);
      if (b.stopped) throw new Error("stopped before it started");
      args.push(`--proxy-pac-url=${pacFor(devices, b.lanPort)}`);
    }
    writeFileSync(config, JSON.stringify({ browser: { launchOptions: { args } } }));
    b.child = spawn(process.execPath, [CLI, ...SERVER_ARGS, `--port=${b.port}`, "--host=127.0.0.1", `--config=${config}`,
      `--user-data-dir=${PROFILES}/${agent}`, `--output-dir=${SHOTS}/${agent}`, "--init-page=/guard/navigation.cjs",
      ...(existsSync(file) ? [`--secrets=${file}`] : [])], { env: { ...process.env, BROWSER_SITES: sites(), BROWSER_LAN: JSON.stringify(devices) }, stdio: ["ignore", "inherit", "inherit"] });
    b.exited = new Promise((resolve) => b.child.once("exit", resolve));
    b.exited.then(() => { if (browsers.get(agent) === b) browsers.delete(agent); });
    log(`started ${agent}'s browser with ${logins} login(s)${devices.length ? ` and ${devices.length} device(s) on your network` : ""}`);
    return answers(b);
  })();
  b.ready.catch((e) => { if (!b.stopped) { log(`${agent}'s browser: ${e.message}`); stop(agent, b); } });
  browsers.set(agent, b);
  return b;
}

function stop(agent, b, why) {
  if (browsers.get(agent) === b) browsers.delete(agent);
  b.stopped = true;
  b.live?.close();
  b.lan?.close();
  if (why) log(`stopping ${agent}'s browser: ${why}`);
  if (!b.child) return Promise.resolve();
  b.child.kill("SIGTERM");
  const force = setTimeout(() => b.child.kill("SIGKILL"), 10_000);
  return b.exited.finally(() => clearTimeout(force));
}

/** The agent's browser, started (or restarted with new logins) when needed. */
function browserFor(agent) {
  let b = browsers.get(agent);
  if (b && b.stamp !== stamp(agent)) b = start(agent, stop(agent, b, "its logins, the sites or its devices changed"));
  if (b) return b;
  if (browsers.size >= MAX_BROWSERS) {
    const idle = [...browsers].filter(([, x]) => x.open === 0).sort(([, x], [, y]) => x.used - y.used)[0];
    if (!idle) return null;
    stop(idle[0], idle[1], `${agent} needs a browser and at most ${MAX_BROWSERS} run at once`);
  }
  return start(agent);
}

setInterval(() => {
  for (const [agent, b] of browsers) {
    if (b.open === 0 && Date.now() - b.used > IDLE_MS) stop(agent, b, "not used for a while");
    // Restarted now rather than on the next call, so it's ready when the agent carries on.
    else if (b.stamp !== stamp(agent)) start(agent, stop(agent, b, "its logins, the sites or its devices changed"));
  }
}, 1000).unref();

const shutdown = async () => {
  await Promise.all([...browsers].map(([a, b]) => stop(a, b)));
  process.exit(0);
};
process.on("SIGTERM", shutdown).on("SIGINT", shutdown);

// ---------- live view: the agent's page as a picture, and the human's input ----------

/** A DevTools connection to one page: send(method, params) → result. */
function devtools(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const waiting = new Map();
    let n = 0;
    const s = {
      closed: false,
      send: (method, params = {}) => new Promise((ok, fail) => {
        if (s.closed) return fail(new Error("the page closed"));
        const id = ++n;
        waiting.set(id, { ok, fail });
        ws.send(JSON.stringify({ id, method, params }));
        setTimeout(() => { if (waiting.delete(id)) fail(new Error(`${method} took too long`)); }, 8000);
      }),
      close: () => ws.close(),
    };
    ws.onopen = () => resolve(s);
    ws.onerror = () => reject(new Error("can't reach the page"));
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data), w = m.id && waiting.get(m.id);
      if (!w) return;
      waiting.delete(m.id);
      if (m.error) w.fail(new Error(m.error.message)); else w.ok(m.result);
    };
    ws.onclose = () => { s.closed = true; for (const w of waiting.values()) w.fail(new Error("the page closed")); waiting.clear(); };
  });
}

/** The page the agent is on (the most recently used tab), with a DevTools connection kept per browser. */
async function livePage(agent) {
  const b = browsers.get(agent);
  if (!b || b.stopped || !b.cdp) return null;
  try { await b.ready; } catch { return null; }
  let pages;
  try { pages = await fetch(`http://127.0.0.1:${b.cdp}/json/list`, { signal: AbortSignal.timeout(2000) }).then((r) => r.json()); }
  catch { return null; } // the browser opens on the agent's first browser tool call
  pages = pages.filter((p) => p.type === "page" && !p.url.startsWith("devtools://"));
  // The tab you picked in the live view while it's open, else the one the browser used last (listed first).
  const page = pages.find((p) => p.id === b.liveTab) ?? pages[0];
  if (!page) return null;
  if (!b.live || b.live.closed || b.live.id !== page.id) {
    b.live?.close();
    b.live = Object.assign(await devtools(page.webSocketDebuggerUrl), { id: page.id });
  }
  return { b, page, pages, s: b.live };
}

const KEYS = { Enter: [13, "\r"], Tab: [9], Backspace: [8], Escape: [27], Delete: [46], ArrowUp: [38], ArrowDown: [40], ArrowLeft: [37], ArrowRight: [39], Home: [36], End: [35] };
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

async function live(res, agent, what, body) {
  const p = await livePage(agent).catch(() => null);
  if (!p) return reply(res, 404, { error: "Its browser isn't open right now: it's open only while the agent is using it, during a run." });
  const { b, page, pages, s } = p;
  if (what === "shot") {
    // Chromium can refuse the first frame just after a navigation ("Unable to capture screenshot"): one more try.
    const capture = () => s.send("Page.captureScreenshot", { format: "jpeg", quality: 70 });
    const [{ cssVisualViewport: v }, { data }] = await Promise.all([s.send("Page.getLayoutMetrics"),
      capture().catch(() => new Promise((r) => setTimeout(r, 400)).then(capture))]);
    res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "no-store", "X-Page-Url": encodeURI(page.url).slice(0, 2000),
      "X-Page-Title": encodeURIComponent(page.title).slice(0, 500), "X-Viewport": `${Math.round(v.clientWidth)}x${Math.round(v.clientHeight)}`,
      // Its tabs, for the tab strip (kept short: it's a header)
      "X-Tabs": encodeURIComponent(JSON.stringify(pages.slice(0, 15).map((t) => ({ id: t.id, title: t.title.slice(0, 60), url: t.url.slice(0, 200), active: t.id === page.id })))) });
    return res.end(Buffer.from(data, "base64"));
  }
  let input;
  try { input = JSON.parse(body); } catch { return reply(res, 400, { error: "expected JSON" }); }
  b.used = Date.now(); // the human working in it keeps it open
  const x = num(input.x), y = num(input.y);
  switch (input.type) {
    case "click":
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await s.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
      break;
    case "scroll":
      await s.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY: Math.max(-3000, Math.min(3000, num(input.dy))) });
      break;
    case "type":
      await s.send("Input.insertText", { text: String(input.text ?? "").slice(0, 2000) });
      break;
    case "key": {
      const k = KEYS[input.key];
      if (!k) return reply(res, 400, { error: "unknown key" });
      await s.send("Input.dispatchKeyEvent", { type: k[1] ? "keyDown" : "rawKeyDown", key: input.key, code: input.key, windowsVirtualKeyCode: k[0], ...(k[1] ? { text: k[1] } : {}) });
      await s.send("Input.dispatchKeyEvent", { type: "keyUp", key: input.key, code: input.key, windowsVirtualKeyCode: k[0] });
      break;
    }
    case "back": {
      const h = await s.send("Page.getNavigationHistory");
      if (h.currentIndex > 0) await s.send("Page.navigateToHistoryEntry", { entryId: h.entries[h.currentIndex - 1].id });
      break;
    }
    case "reload":
      await s.send("Page.reload");
      break;
    case "tab": { // show another of its tabs (the agent keeps working in whichever tab it was using)
      const t = pages.find((x) => x.id === input.id);
      if (!t) return reply(res, 404, { error: "That tab is closed" });
      b.liveTab = t.id;
      await fetch(`http://127.0.0.1:${b.cdp}/json/activate/${t.id}`, { signal: AbortSignal.timeout(2000) }).catch(() => {});
      break;
    }
    case "close-tab": {
      const t = pages.find((x) => x.id === input.id);
      if (!t) return reply(res, 404, { error: "That tab is closed" });
      if (pages.length < 2) return reply(res, 400, { error: "It's the browser's last tab" });
      if (b.liveTab === t.id) b.liveTab = null;
      await fetch(`http://127.0.0.1:${b.cdp}/json/close/${t.id}`, { signal: AbortSignal.timeout(2000) });
      break;
    }
    default:
      return reply(res, 400, { error: "unknown input" });
  }
  reply(res, 200, { ok: true });
}

// ---------- the proxy ----------

const reply = (res, status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
const refusal = (id, text) => ({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text }] } });

// tools/list results without the blocked tools (a JSON body, or one SSE data line).
const withoutBlocked = (text) => {
  try {
    const j = JSON.parse(text);
    for (const m of [j].flat()) if (Array.isArray(m?.result?.tools)) m.result.tools = m.result.tools.filter((t) => !BLOCKED.has(t.name));
    return JSON.stringify(j);
  } catch { return text; }
};

http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const body = Buffer.concat(chunks);
    const lv = req.url.match(/^\/live\/([a-z0-9][a-z0-9-]{1,30}[a-z0-9])\/(shot|input)$/);
    if (lv && (lv[2] === "shot" ? req.method === "GET" : req.method === "POST")) {
      return live(res, lv[1], lv[2], body.toString()).catch((e) => { if (!res.headersSent) reply(res, 502, { error: e.message }); else res.end(); });
    }
    const agent = String(req.headers["x-agent"] ?? "");
    if (!AGENT_RE.test(agent)) return reply(res, 400, { error: "No agent named: only the agents app connects to the browser" });
    let messages = [];
    if (req.method === "POST") { try { messages = [JSON.parse(body)].flat(); } catch { /* not JSON: the server answers */ } }
    for (const m of messages.filter((m) => m?.method === "tools/call")) {
      const denied = BLOCKED.has(m.params?.name) ? `${m.params.name} is turned off here: it could expose saved logins.`
        : notGranted(m.params?.arguments, agent).map((n) => `${n} is a saved login that ${agent} may not use. ` +
          "Ask for it with request_login: the human decides who may use it.").join(" ");
      if (denied) {
        log(`refused ${m.params?.name} for ${agent}${BLOCKED.has(m.params?.name) ? "" : ": login not granted"}`);
        return reply(res, 200, refusal(m.id, denied));
      }
    }
    const b = browserFor(agent);
    if (!b) return reply(res, 503, { error: `Every browser is busy (at most ${MAX_BROWSERS} at once): try again shortly` });
    b.open++; b.used = Date.now();
    res.on("close", () => { b.open--; b.used = Date.now(); });
    let port;
    try { port = await b.ready; } catch { return reply(res, 503, { error: "the browser is restarting" }); }
    const listing = messages.some((m) => m?.method === "tools/list");
    const up = http.request({ host: "127.0.0.1", port, method: req.method, path: req.url, headers: { ...req.headers, host: `127.0.0.1:${port}` } }, (ur) => {
      if (!listing) { res.writeHead(ur.statusCode, ur.headers); return ur.pipe(res); }
      const out = [];
      ur.on("data", (c) => out.push(c));
      ur.on("end", () => {
        const text = Buffer.concat(out).toString();
        const sse = /text\/event-stream/.test(ur.headers["content-type"] ?? "");
        const headers = { ...ur.headers };
        delete headers["content-length"]; delete headers["transfer-encoding"];
        res.writeHead(ur.statusCode, headers);
        res.end(sse ? text.replace(/^data: ?(.*)$/gm, (_, d) => `data: ${withoutBlocked(d)}`) : withoutBlocked(text));
      });
    });
    up.on("error", () => { if (!res.headersSent) reply(res, 503, { error: "the browser is restarting" }); else res.end(); });
    res.on("close", () => { if (!res.writableEnded) up.destroy(); }); // the agent went away mid-answer
    up.end(body);
  });
}).listen(PORT, "0.0.0.0", () => log(`on port ${PORT}: a browser per agent, at most ${MAX_BROWSERS} at once`));
