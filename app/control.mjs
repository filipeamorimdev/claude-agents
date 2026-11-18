// Signed calls from the app to its helper containers (the command sandbox, shell.mjs, and the LAN gateway, lan.mjs).
//
// Checking the caller's address isn't enough: an agent's own commands can run inside the app's container (Codex's
// sandboxed shell, or Bash) and would look like the app. So every call is signed with a key only the app holds:
//   - init.sh makes an Ed25519 key pair once: the private key in DATA_DIR/agents/home/control.key (the app's home,
//     hidden from agents: engine.mjs and codex.mjs deny it), the public key in DATA_DIR/config/control.pub
//   - the sandbox and the gateway mount only the public key: a command that reads it can verify, not sign
//   - a signature covers the method, path, time and body, and is accepted once, within a minute
//
//   node control.mjs keygen <private key file> <public key file>   (init.sh; keeps an existing pair)

import crypto from "node:crypto";
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CONTROL_HEADER = "X-Control";
const MAX_SKEW_MS = 60_000;

const digest = (method, p, at, nonce, body) =>
  Buffer.from(`${method.toUpperCase()} ${p}\n${at}\n${nonce}\n${crypto.createHash("sha256").update(body ?? "").digest("hex")}`);

/** The app's side: headers for one call. Throws when the key is missing (the stack's init didn't run). */
export function signer(file = process.env.CONTROL_KEY || path.join(process.env.HOME || "/data/home", "control.key")) {
  let key = null;
  const load = () => (key ??= crypto.createPrivateKey(readFileSync(file)));
  return (method, p, body = "") => {
    try { load(); } catch { throw new Error(`The app's control key (${file}) is missing: redeploy the stack so its init service creates it.`); }
    const at = Date.now(), nonce = crypto.randomBytes(12).toString("hex");
    const sig = crypto.sign(null, digest(method, p, at, nonce, body), key).toString("base64url");
    return { [CONTROL_HEADER]: `${at}.${nonce}.${sig}` };
  };
}

/** The helper's side: (req, rawBody) => true when the app signed exactly this call, once. */
export function verifier(file = process.env.CONTROL_PUB || "/run/control.pub") {
  let key = null;
  const seen = new Map(); // nonce -> time, for a minute: a captured call can't be sent again
  return (req, body = "") => {
    try { key ??= crypto.createPublicKey(readFileSync(file)); } catch { return false; }
    const m = String(req.headers[CONTROL_HEADER.toLowerCase()] ?? "").match(/^(\d{10,16})\.([a-f0-9]{24})\.([A-Za-z0-9_-]{40,200})$/);
    if (!m) return false;
    const at = Number(m[1]);
    if (Math.abs(Date.now() - at) > MAX_SKEW_MS || seen.has(m[2])) return false;
    const p = new URL(req.url, "http://x").pathname;
    let ok = false;
    try { ok = crypto.verify(null, digest(req.method, p, at, m[2], body), key, Buffer.from(m[3], "base64url")); } catch { ok = false; }
    if (!ok) return false;
    for (const [n, t] of seen) if (Date.now() - t > MAX_SKEW_MS * 2) seen.delete(n);
    seen.set(m[2], at);
    return true;
  };
}

// ---------- keygen (init.sh) ----------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === "keygen") {
  const [priv, pub] = process.argv.slice(3);
  if (!priv || !pub) { console.error("usage: node control.mjs keygen <private key file> <public key file>"); process.exit(2); }
  if (!existsSync(priv)) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    writeFileSync(priv, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    writeFileSync(pub, publicKey.export({ type: "spki", format: "pem" }), { mode: 0o644 });
    console.log("created the app's control key");
  } else if (!existsSync(pub)) {
    writeFileSync(pub, crypto.createPublicKey(readFileSync(priv)).export({ type: "spki", format: "pem" }), { mode: 0o644 });
  }
  chmodSync(priv, 0o600); chmodSync(pub, 0o644);
}
