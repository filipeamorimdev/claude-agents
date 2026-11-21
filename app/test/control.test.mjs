// node --test: signed calls and agent tokens (control.mjs), and the vault refusing unsigned calls (vault.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { agentTokens, agentTokenVerifier, signer, verifier, CONTROL_HEADER } from "../control.mjs";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir = mkdtempSync(path.join(tmpdir(), "control-"));
const KEY = path.join(dir, "control.key"), PUB = path.join(dir, "control.pub");
execFileSync(process.execPath, [path.join(APP, "control.mjs"), "keygen", KEY, PUB]);

test("an agent token is good for that agent only", () => {
  const token = agentTokens(KEY), ok = agentTokenVerifier(PUB);
  assert.equal(ok("alpha", token("alpha")), true);
  assert.equal(token("alpha"), token("alpha"), "the same every time");
  assert.equal(ok("beta", token("alpha")), false);
  assert.equal(ok("alpha", ""), false);
  assert.equal(ok("alpha", undefined), false);
});

test("an agent token is not a control signature", () => {
  const t = agentTokens(KEY)("alpha");
  const req = { method: "GET", url: "/logins", headers: { [CONTROL_HEADER.toLowerCase()]: `${Date.now()}.${"a".repeat(24)}.${t}` } };
  assert.equal(verifier(PUB)(req, ""), false);
});

test("a signed call is accepted once, and only for its own method, path and body", () => {
  const sign = signer(KEY), check = verifier(PUB);
  const h = sign("POST", "/sites", '{"add":"x.pt"}');
  const req = (method, url) => ({ method, url, headers: { [CONTROL_HEADER.toLowerCase()]: h[CONTROL_HEADER] } });
  assert.equal(check(req("POST", "/grants/X"), '{"add":"x.pt"}'), false);
  assert.equal(check(req("POST", "/sites"), '{"add":"y.pt"}'), false);
  assert.equal(check(req("POST", "/sites"), '{"add":"x.pt"}'), true);
  assert.equal(check(req("POST", "/sites"), '{"add":"x.pt"}'), false, "replayed");
});

const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });

test("the vault refuses every unsigned call but /health", async (t) => {
  const port = await freePort();
  for (const d of ["vault", "out", "lan"]) mkdirSync(path.join(dir, d), { recursive: true });
  const vault = spawn(process.execPath, [path.join(APP, "vault.mjs")], { stdio: "ignore", env: { ...process.env,
    VAULT_DIR: path.join(dir, "vault"), VAULT_OUT: path.join(dir, "out"), LAN_LOGINS_OUT: path.join(dir, "lan"), VAULT_PORT: String(port),
    CONTROL_PUB: PUB, BROWSER_SECRETS: "", BROWSER_ALLOWED_ORIGINS: "" } });
  t.after(() => vault.kill());
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${url}/health`)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 100)); }
  assert.equal((await fetch(`${url}/health`)).status, 200);

  const json = { "Content-Type": "application/json" };
  assert.equal((await fetch(`${url}/logins`)).status, 403);
  assert.equal((await fetch(`${url}/sites`, { method: "POST", headers: json, body: '{"add":"evil.example"}' })).status, 403);
  assert.equal((await fetch(`${url}/logins/BANK_PASSWORD`, { method: "PUT", headers: json, body: '{"value":"x","grant":["alpha"]}' })).status, 403);

  process.env.CONTROL_KEY = KEY;
  const { vaultClient } = await import("../logins.mjs");
  const v = vaultClient(url);
  await v.save("BANK_PASSWORD", "secret", "bank.example", ["alpha"]);
  await v.sites({ add: "bank.example" });
  const list = await v.list();
  assert.deepEqual(list.logins.map((l) => [l.name, l.agents]), [["BANK_PASSWORD", ["alpha"]]]);
  assert.deepEqual(list.sites.map((s) => s.rule), ["bank.example"]);
  assert.equal((await fetch(`${url}/grants/BANK_PASSWORD`, { method: "POST", headers: json, body: '{"agents":["beta"]}' })).status, 403);
  assert.deepEqual((await v.list()).logins[0].agents, ["alpha"]);
});
