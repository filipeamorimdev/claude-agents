// Native push notifications (Web Push): every confirmed device gets one when an agent run ends,
// whatever started it (schedule, chat, group, CLI, another agent).
//
// A device is a browser, or the chat installed as an app (Home Screen on iPhone/iPad), that turned
// notifications on from the chat UI. Notifications go through that browser's own push service
// (Apple, Google or Mozilla), end-to-end encrypted to the device: the push service can't read them.
// Built on node:crypto only: message encryption is RFC 8291, the server's signature (VAPID) RFC 8292.
//
// Adding a device:  in the chat on the device ("Turn on notifications here"), or `agents devices add <name>`
//                   which gives a pairing code to enter in the chat on the device.
// Confirming it:    it then gets a "Confirm this device" notification: tapping it (or typing its code)
//                   confirms it. Until then it gets nothing else, so you know notifications really arrive.
// Subscriptions and the server's key live only in the database, which the agents can't read.

import crypto from "node:crypto";

const CODE_TTL_MIN = 15;
const CODE_ATTEMPTS = 5;
const TIMEOUT_MS = 10_000;
const PAYLOAD_MAX = 3000;           // bytes of JSON; a push message holds at most ~4 KB
const CONTACT = "https://github.com/filipeamorimdev/claude-agents"; // the push services' contact for this sender
const MAX_DEVICES = 10;
const PAIR_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const TRIGGERS = { schedule: "scheduled run", manual: "run now", chat: "chat", "ask:human": "asked from the CLI" };

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const fromB64u = (s) => Buffer.from(String(s), "base64url");
const hash = (s) => crypto.createHash("sha256").update(s).digest("hex");
const triggerLabel = (t) => TRIGGERS[t] ?? (t.startsWith("agent:") ? `asked by ${t.slice(6)}` : t.startsWith("group:") ? "group chat" : t);
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/;
const NAME_RULE = "name: 2-32 chars, lowercase letters, digits and dashes";

// ---------- the server's key (VAPID) ----------
// Made on first use and kept: every subscription is tied to it, so a new key would silence every device.
const keysCache = new WeakMap();
export function vapidKeys(store) {
  if (keysCache.has(store)) return keysCache.get(store);
  if (!store.getMeta("vapid_key")) {
    const jwk = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "jwk" });
    store.db.prepare("INSERT OR IGNORE INTO meta(key,value) VALUES('vapid_key',?)").run(JSON.stringify(jwk)); // the runner and CLI may race
  }
  const jwk = JSON.parse(store.getMeta("vapid_key"));
  const keys = {
    privateKey: crypto.createPrivateKey({ key: jwk, format: "jwk" }),
    publicKey: b64u(Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)])), // what browsers subscribe with
  };
  keysCache.set(store, keys);
  return keys;
}

function vapidHeader(endpoint, { privateKey, publicKey }) {
  const part = (o) => b64u(JSON.stringify(o));
  const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: CONTACT })}`;
  const sig = crypto.sign("sha256", Buffer.from(unsigned), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return `vapid t=${unsigned}.${b64u(sig)}, k=${publicKey}`;
}

// ---------- message encryption (RFC 8291, "aes128gcm") ----------
/** Encrypt a payload for one subscription. `fixed` ({ asPrivate, salt }) is only for the RFC's test vector. */
export function encrypt(plaintext, { p256dh, auth }, fixed = {}) {
  const uaPublic = fromB64u(p256dh), authSecret = fromB64u(auth);
  const ecdh = crypto.createECDH("prime256v1");
  if (fixed.asPrivate) ecdh.setPrivateKey(fromB64u(fixed.asPrivate)); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const salt = fixed.salt ? fromB64u(fixed.salt) : crypto.randomBytes(16);
  const hkdf = (ikm, s, info, len) => Buffer.from(crypto.hkdfSync("sha256", ikm, s, Buffer.from(info), len));
  const ikm = hkdf(ecdh.computeSecret(uaPublic), authSecret, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]), 32);
  const cek = hkdf(ikm, salt, "Content-Encoding: aes128gcm\0", 16);
  const nonce = hkdf(ikm, salt, "Content-Encoding: nonce\0", 12);
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const sealed = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header); header.writeUInt32BE(4096, 16); header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, sealed]);
}

/** Check a subscription sent by a browser (PushSubscription.toJSON()). */
export function validateSubscription(sub) {
  const endpoint = String(sub?.endpoint ?? ""), p256dh = String(sub?.keys?.p256dh ?? ""), auth = String(sub?.keys?.auth ?? "");
  let ok = endpoint.length <= 1024;
  try { ok &&= new URL(endpoint).protocol === "https:"; } catch { ok = false; }
  const key = fromB64u(p256dh);
  ok &&= key.length === 65 && key[0] === 4 && fromB64u(auth).length === 16;
  if (!ok) throw Object.assign(new Error("this browser sent an invalid push subscription"), { code: 400 });
  return { endpoint, p256dh, auth };
}

/** Send one notification to a device. Throws with a readable reason when the push service doesn't take it. */
export async function push(store, device, data, urgency = "normal") {
  if (!device.endpoint) throw new Error(`${device.name} isn't connected: turn notifications on in the chat on that device`);
  let res;
  try {
    res = await fetch(device.endpoint, {
      method: "POST",
      headers: { "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: "86400", Urgency: urgency,
        Authorization: vapidHeader(device.endpoint, vapidKeys(store)) },
      body: encrypt(JSON.stringify(data), device),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const host = new URL(device.endpoint).host;
    throw new Error(e.name === "TimeoutError" ? `${host} didn't answer` : `can't reach ${host}: ${e.cause?.message ?? e.message}`);
  }
  if (res.status === 404 || res.status === 410) {
    store.disconnectDevice(device.name);
    throw new Error(`${device.name} turned notifications off (or the browser data was cleared): turn them on again on that device`);
  }
  if (!res.ok) throw new Error(`${new URL(device.endpoint).host} answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
}

// ---------- devices ----------
export function checkName(name, count) {
  const errors = [];
  if (!NAME_RE.test(name)) errors.push(NAME_RULE);
  if (count >= MAX_DEVICES) errors.push(`at most ${MAX_DEVICES} devices`);
  return errors;
}

/** A device to connect later from its own browser (the CLI's way). Returns the pairing code. */
export function createPairing(store, name, actor) {
  const errors = checkName(name, store.devices().length);
  if (errors.length) throw new Error(errors.join("; "));
  const code = Array.from({ length: 8 }, () => PAIR_ALPHABET[crypto.randomInt(PAIR_ALPHABET.length)]).join("").replace(/^(.{4})/, "$1-");
  store.addDevice({ name, pairHash: hash(code), pairExpires: new Date(Date.now() + CODE_TTL_MIN * 60e3).toISOString() }, actor);
  return code;
}

/**
 * This browser's subscription becomes a device: a new one (name) or the one a pairing code was made for (pair).
 * Then it gets the confirmation notification. Returns { device, error } (error: the confirmation couldn't be sent).
 */
export async function connect(store, { name, pair, subscription, platform }, actor) {
  const sub = validateSubscription(subscription);
  const taken = store.devices().find((d) => d.endpoint === sub.endpoint);
  if (taken) throw Object.assign(new Error(`This browser already gets notifications as ${taken.name}`), { code: 409 });
  if (pair) {
    const code = String(pair).toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^(.{4})/, "$1-");
    const d = store.devices().find((x) => x.pairHash === hash(code));
    if (!d || Date.parse(d.pairExpires) < Date.now()) throw Object.assign(new Error("Unknown or expired pairing code. Make a new one: agents devices add <name>"), { code: 400 });
    name = d.name;
  } else {
    const errors = checkName(name, store.devices().length);
    if (errors.length) throw Object.assign(new Error(errors.join("; ")), { code: 400 });
    if (store.device(name)) throw Object.assign(new Error(`There is already a device called ${name}`), { code: 409 });
    store.addDevice({ name }, actor);
  }
  store.connectDevice(name, { ...sub, platform: String(platform ?? "").slice(0, 60) }, actor);
  const error = await sendCode(store, name).then(() => null, (e) => e.message);
  return { device: store.device(name), error };
}

/** Send the "Confirm this device" notification with a new code (replaces any earlier code). */
export async function sendCode(store, name) {
  const d = store.device(name);
  if (!d) throw new Error(`no device "${name}"`);
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  store.setDeviceCode(name, hash(code), new Date(Date.now() + CODE_TTL_MIN * 60e3).toISOString());
  await push(store, d, {
    title: "Confirm this device", body: `Tap to confirm ${name}, or enter ${code}. Valid for ${CODE_TTL_MIN} minutes.`,
    tag: "confirm", url: "/#devices", confirm: { device: name, code },
  }, "high");
}

/** Check a code (tapped or typed). Throws with what to do next when it doesn't match. */
export function checkCode(store, name, code, actor) {
  const d = store.device(name);
  if (!d) throw new Error(`no device "${name}"`);
  if (d.verifiedAt) return;
  const resend = `send a new one: agents devices verify ${name}`;
  if (!d.codeHash) throw new Error(`no code sent yet: agents devices verify ${name}`);
  if (Date.parse(d.codeExpires) < Date.now()) throw new Error(`the code expired, ${resend}`);
  if (d.codeAttempts >= CODE_ATTEMPTS) throw new Error(`too many wrong codes, ${resend}`);
  const given = Buffer.from(hash(String(code).trim()), "hex");
  if (!crypto.timingSafeEqual(given, Buffer.from(d.codeHash, "hex"))) {
    store.failDeviceCode(name);
    const left = CODE_ATTEMPTS - d.codeAttempts - 1;
    throw new Error(`wrong code, ${left ? `${left} attempt(s) left` : resend}`);
  }
  store.verifyDevice(name, actor);
}

/** Send a test notification to a confirmed device. */
export async function testDevice(store, name) {
  const d = store.device(name);
  if (!d) throw new Error(`no device "${name}"`);
  if (!d.verifiedAt) throw new Error(`${name} isn't confirmed yet`);
  await push(store, d, { title: "Test notification", body: `Notifications work on ${name}.`, tag: "test", url: "/#devices" });
  store.deviceSent(name, null);
}

/** What the UI shows: never the subscription itself. endpointId lets a browser recognise its own device. */
export const deviceView = (d) => ({
  name: d.name, platform: d.platform, connected: !!d.endpoint, endpointId: d.endpoint ? hash(d.endpoint).slice(0, 16) : null,
  pairPending: !d.endpoint && !!d.pairHash && Date.parse(d.pairExpires) > Date.now(), pairExpires: d.pairExpires,
  verified: !!d.verifiedAt, verifiedAt: d.verifiedAt, codePending: !!d.codeHash && Date.parse(d.codeExpires) > Date.now(),
  lastSentAt: d.lastSentAt, lastError: d.lastError, createdAt: d.createdAt,
});

/** One line per device for the CLI and logs. */
export function deviceStatus(d) {
  if (d.verifiedAt && d.endpoint) return "confirmed";
  if (d.endpoint) return "waiting for confirmation";
  if (d.pairHash && Date.parse(d.pairExpires) > Date.now()) return "waiting for pairing";
  return d.pairHash ? "pairing code expired" : "disconnected";
}

/** Tell every confirmed device that a run ended. Never throws: failures are logged and shown with the devices. */
export async function notifyRun(store, { agent, trigger, ok, result, model, effort, seconds }, log) {
  const devices = store.devices().filter((d) => d.verifiedAt && d.endpoint);
  if (!devices.length) return;
  const a = store.get(agent);
  const footer = `\n${triggerLabel(trigger)} · ${model}/${effort} · ${seconds}s`;
  let text = String(result ?? "").replace(/\s+\n/g, "\n").trim() || "No result.";
  const data = () => ({ title: `${a?.displayName || agent} ${ok ? "finished" : "failed"}`, body: text + footer, url: `/#agent=${agent}` });
  while (Buffer.byteLength(JSON.stringify(data())) > PAYLOAD_MAX) text = `${text.slice(0, Math.floor(text.length * 0.8))}…`;
  await Promise.all(devices.map(async (d) => {
    try {
      await push(store, d, data(), ok ? "normal" : "high");
      store.deviceSent(d.name, null);
    } catch (e) {
      store.deviceSent(d.name, e.message);
      log("notify", `could not notify ${d.name}: ${e.message}`);
    }
  }));
}
