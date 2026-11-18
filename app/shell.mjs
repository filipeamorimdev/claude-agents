// The command sandbox: where an agent's terminal commands run, after the human approved each one.
// Runs as its own container (service "shell", same image as the app): node shell.mjs
//
// The approval is not the protection: a human can approve a bad command by mistake. The protection is what
// this container doesn't have:
//   - it mounts only the agents' workspace folders (DATA_DIR/agents/workspaces). The database, the logs,
//     the app's home (Claude and ChatGPT sign-ins), the config, the vault and the stack's variables (.env:
//     the UI password, tokens) aren't here, so no command can read them, change them or purge the log
//   - it sits on its own network with only the app. The vault and the browsers are on another network it
//     can't reach, and the firewall keeps it away from your LAN and this host, with no exceptions
//   - non-root, no capabilities, read-only root filesystem; /tmp is in memory
//   - it runs commands only for the app: every request must be signed with the app's control key (control.mjs),
//     which only the app holds. A request from anywhere else (a command calling back, another container, an agent's
//     own commands inside the app's container) is refused, so nothing runs here that wasn't approved and logged
//   - the LAN: none by default. A command gets a way to the home network only when its agent was granted targets
//     (each one an IP and port) and the command was approved with LAN access: then LAN_PROXY points at the LAN
//     gateway (lan.mjs) with a token for that one command, and `lan <command>` uses it. The gateway lets it reach
//     only that agent's targets; the token dies when the command ends
//   - one command at a time; when it ends (or its time is up) everything it started is killed, so nothing
//     keeps running in the background
// What a command prints goes back to the app, which writes the log. Nothing here can touch that log.
//
// Also the client the app uses to reach it (shellClient).

import http from "node:http";
import dns from "node:dns/promises";
import { spawn } from "node:child_process";
import { readdirSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signer, verifier } from "./control.mjs";

export const COMMAND_MAX = 2000;                  // characters in one command
export const TIMEOUT_DEFAULT = 120, TIMEOUT_MAX = 600; // seconds a command may run
const OUTPUT_MAX = 200_000;                       // bytes of output kept (the first half and the last half)
const AGENT_NAME_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

/** The app's side. run() resolves with { exitCode, signal, timedOut, output, truncated, seconds }. */
export function shellClient(url = process.env.SHELL_URL || "http://shell:8933") {
  const sign = signer();
  return {
    /** lanProxy: the LAN gateway's address with this command's token (LAN_PROXY), or null for no LAN. */
    async run(agent, command, timeout = TIMEOUT_DEFAULT, lanProxy = null) {
      let res;
      const body = JSON.stringify({ agent, command, timeout, ...(lanProxy ? { lanProxy } : {}) });
      try {
        res = await fetch(`${url}/exec`, {
          method: "POST", headers: { "Content-Type": "application/json", ...sign("POST", "/exec", body) }, body,
          signal: AbortSignal.timeout((timeout + 30) * 1000),
        });
      } catch (e) {
        throw new Error(e?.name === "TimeoutError" ? "The command sandbox didn't answer in time." : "The command sandbox isn't running (the stack's \"shell\" container).");
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `The command sandbox answered ${res.status}`);
      return data;
    },
  };
}

// ---------- the server (only when run as the container's command) ----------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ROOT = process.env.SHELL_WORKSPACES || "/workspaces";
  const PORT = Number(process.env.SHELL_PORT || 8933);
  const CALLER = process.env.SHELL_CALLER || "claude-agents"; // the app's name on the shared network
  const log = (msg) => console.log(`${new Date().toISOString()} [shell] ${msg}`);
  const send = (res, code, body) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  const addr = (a) => String(a ?? "").replace(/^::ffff:/, "");

  const signed = verifier();
  /** Whether a request comes from the app's container: its address on the network we share, never this container itself. */
  async function fromApp(req) {
    const from = addr(req.socket.remoteAddress), here = addr(req.socket.localAddress);
    if (!from || from === here || from === "127.0.0.1" || from === "::1") return false;
    try { return (await dns.lookup(CALLER, { all: true })).some((a) => addr(a.address) === from); } catch { return false; }
  }

  /** Kill everything except this server and the container's init: what a command left running. */
  function sweep() {
    let killed = 0;
    for (const d of readdirSync("/proc")) {
      const pid = Number(d);
      if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) continue;
      try { process.kill(pid, "SIGKILL"); killed++; } catch { /* already gone */ }
    }
    return killed;
  }

  function run(agent, command, timeout, lanProxy) {
    return new Promise((resolve0) => {
      let settled = false;
      const resolve = (v) => { if (!settled) { settled = true; resolve0(v); } };
      const started = Date.now();
      const HALF = OUTPUT_MAX / 2;
      let head = Buffer.alloc(0), tail = Buffer.alloc(0), dropped = 0, timedOut = false;
      const keep = (chunk) => { // the first half and the last half of what it prints
        if (head.length < HALF) { const c = chunk.subarray(0, HALF - head.length); head = Buffer.concat([head, c]); chunk = chunk.subarray(c.length); }
        if (!chunk.length) return;
        tail = Buffer.concat([tail, chunk]);
        if (tail.length > HALF) { dropped += tail.length - HALF; tail = tail.subarray(tail.length - HALF); }
      };
      // A minimal environment: nothing of this container's own. AGENT_RUN marks it as started by an agent.
      const child = spawn("/bin/sh", ["-c", command], {
        cwd: path.join(ROOT, agent), detached: true, stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: process.env.PATH, HOME: "/tmp/home", TMPDIR: "/tmp", TZ: process.env.TZ ?? "UTC", LANG: "C.UTF-8", AGENT_RUN: "1",
          ...(lanProxy ? { LAN_PROXY: lanProxy } : {}) },
      });
      const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } }, timeout * 1000);
      child.stdout.on("data", keep); child.stderr.on("data", keep);
      const done = (exitCode, signal, error) => {
        clearTimeout(timer);
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* nothing left in its group */ }
        const left = sweep();
        const output = head.toString("utf8") + (dropped ? `\n… (${dropped} bytes left out) …\n` : "") + tail.toString("utf8");
        resolve({ exitCode, signal, timedOut, output: error ? `${output}${error}` : output, truncated: dropped > 0, seconds: Math.round((Date.now() - started) / 100) / 10, leftRunning: left });
      };
      child.on("error", (e) => done(127, null, `Could not start the command: ${e.message}`));
      // The moment the command itself ends, whatever it left in the background is killed: otherwise a leftover
      // process holding the output open would keep this waiting until the time is up.
      child.on("exit", () => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* nothing left in its group */ } sweep(); });
      child.on("close", (code, signal) => done(code, signal));
    });
  }

  let queue = Promise.resolve(); // one command at a time, so the sweep after one never hits another
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true });
      if (req.method !== "POST" || req.url !== "/exec") return send(res, 404, { error: "not found" });
      if (!(await fromApp(req))) { log(`refused a request from ${addr(req.socket.remoteAddress)}`); return send(res, 403, { error: "only the app runs commands here" }); }
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > 64 * 1024) return send(res, 413, { error: "too large" }); chunks.push(c); }
      const raw = Buffer.concat(chunks).toString();
      if (!signed(req, raw)) { log(`refused an unsigned request from ${addr(req.socket.remoteAddress)}`); return send(res, 403, { error: "only the app runs commands here" }); }
      let body; try { body = JSON.parse(raw || "{}"); } catch { return send(res, 400, { error: "invalid JSON" }); }
      const agent = String(body.agent ?? ""), command = String(body.command ?? "");
      const timeout = Math.min(Math.max(Number(body.timeout) || TIMEOUT_DEFAULT, 1), TIMEOUT_MAX);
      if (!AGENT_NAME_RE.test(agent) || !existsSync(path.join(ROOT, agent))) return send(res, 400, { error: `no folder for agent "${agent}"` });
      if (!command.trim() || command.length > COMMAND_MAX) return send(res, 400, { error: `a command is 1 to ${COMMAND_MAX} characters` });
      const lanProxy = body.lanProxy == null ? null : String(body.lanProxy);
      if (lanProxy && !/^http:\/\/[a-z0-9-]+:[A-Za-z0-9_-]{20,80}@[a-z0-9.-]+:\d{2,5}$/.test(lanProxy)) return send(res, 400, { error: "bad LAN proxy" });
      const go = () => run(agent, command, timeout, lanProxy);
      const result = await (queue = queue.then(go, go));
      log(`${agent}: exit ${result.exitCode ?? result.signal}${result.timedOut ? " (time up)" : ""} in ${result.seconds}s${lanProxy ? " (with LAN access)" : ""}`);
      send(res, 200, result);
    } catch (e) {
      log(`ERROR: ${e?.message || e}`);
      if (!res.headersSent) send(res, 500, { error: "the command sandbox failed" });
    }
  });
  mkdirSync("/tmp/home", { recursive: true, mode: 0o700 }); // commands' HOME (ssh keeps known_hosts there)
  process.on("SIGTERM", () => { sweep(); process.exit(0); });
  server.listen(PORT, "0.0.0.0", () => log(`command sandbox listening on port ${PORT}, for ${CALLER} only`));
}
