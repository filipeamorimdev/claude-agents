// One way to read an address someone typed (a site, a login's site, a device), shared by the app, the vault and the
// LAN gateway. Two kinds:
//   - a website: a public host name, with or without a scheme and a port ("vinted.pt", "https://shop.example:8443")
//   - a device on your network: one private IPv4 address and one port ("10.0.0.1:8443", "http://192.168.1.50")
// Anything else (a bare name like "vault", localhost, a public IP, a subnet) is neither, so it can't point an agent at the
// stack's own containers. A device is reached only through the LAN gateway, and only once you granted it (lan.mjs).

import net from "node:net";

const HOST_RE = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

/** A private address on your network: 10/8, 172.16/12, 192.168/16, 100.64/10 (Tailscale). */
export const privateIPv4 = (s) => {
  if (!net.isIPv4(String(s ?? ""))) return false;
  const [a, b] = String(s).split(".").map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
};

/**
 * What an address is: { kind: "site", origin, host } | { kind: "device", host, port, tls, origin } | null.
 * Without a scheme a site is https, and a device is http unless its port is 443 or 8443.
 */
export function parseAddress(input) {
  const s = String(input ?? "").trim();
  if (!s || /\s/.test(s)) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s)?.[1]?.toLowerCase();
  if (scheme && scheme !== "http" && scheme !== "https") return null;
  let u;
  try { u = new URL(scheme ? s : `http://${s}`); } catch { return null; }
  if (u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  if (privateIPv4(host)) {
    const explicit = u.port ? Number(u.port) : null;
    const tls = scheme ? scheme === "https" : explicit === 443 || explicit === 8443;
    const port = explicit ?? (tls ? 443 : 80);
    return { kind: "device", host, port, tls, origin: new URL(`${tls ? "https" : "http"}://${host}:${port}`).origin };
  }
  if (!HOST_RE.test(host)) return null;
  const origin = new URL(`${scheme ?? "https"}://${host}${u.port ? `:${u.port}` : ""}`).origin;
  return { kind: "site", host, origin };
}

/** A device address ("10.0.0.1:8443", "https://10.0.0.1:8443/Main_Login.asp") or null. */
export const deviceOf = (input) => { const a = parseAddress(input); return a?.kind === "device" ? a : null; };
