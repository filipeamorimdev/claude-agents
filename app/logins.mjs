// Site logins for the browser agent: the rules shared by the vault (vault.mjs, its own container)
// and the app, plus the client the app uses to reach the vault over the internal network.
//
// A login is a NAME (e.g. VINTED_PASSWORD) and a value. Agents only ever see names: they type a name
// into a sign-in form and the browser fills in the value. The value goes from the chat UI straight
// to the vault and never into the database, the logs or an agent's context.

export const LOGIN_NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
export const AGENT_NAME_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
/** The header that tells the browser's guard which agent is calling (set by the app, never by the agent). */
export const AGENT_HEADER = "X-Agent";
export const MAX_LOGIN_VALUE = 4096;
import { deviceOf } from "./address.mjs";
export { deviceOf };
export { parseAddress } from "./address.mjs";
const HOST_RE = /^(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

/** The origin of a web address ("vinted.pt/login" -> "https://vinted.pt"), or null for anything else. */
export function originOf(site) {
  const s = String(site ?? "").trim();
  if (!s) return null;
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`);
    if (!/^https?:$/.test(u.protocol) || !HOST_RE.test(u.hostname) || u.username || u.password) return null;
    return u.origin;
  } catch { return null; }
}

/**
 * Where a login is used: a website's origin, or a device on your network as the browser opens it (always
 * http://IP:PORT: the LAN gateway does the https). Null for anything else.
 */
export function loginSite(site) {
  const d = deviceOf(site);
  return d ? `http://${d.host}:${d.port}` : originOf(site);
}

/**
 * A site the browser may open, as Playwright's --allowed-origins takes it: an origin ("https://www.olx.pt"),
 * a host ("vinted.pt") or every subdomain ("*.vinted.net"). Null when it isn't one. Never a bare name or
 * an IP, so the browser can't be pointed at the internal network (vault, browser, app).
 */
export function siteRule(site) {
  const s = String(site ?? "").trim().toLowerCase().replace(/\/+$/, "");
  if (/^https?:\/\//.test(s)) return originOf(s);
  if (/:\d{1,5}$/.test(s)) return originOf(s); // "shop.example:8443" -> https://shop.example:8443
  return HOST_RE.test(s) ? s : null;
}

/** Whether a rule list lets the browser open an origin (the same matching Playwright does). */
export function siteAllowed(origin, rules) {
  const host = (() => { try { return new URL(origin).hostname; } catch { return ""; } })();
  return rules.some((r) => r === origin || r === host || (r.startsWith("*.") && host.endsWith(r.slice(1))));
}

/** Agents with a browser that fills in vault logins: the registry flag `logins`, the "browser" server by default. */
export const usesLogins = (tools, registry) =>
  tools.some((t) => t.startsWith("mcp__") && (registry[t.slice(5)]?.logins ?? t === "mcp__browser"));

/** Resolves once something answers at url without a server error (the browser's guard says 503 while it restarts), or after ms. */
export async function waitUntilUp(url, ms = 30_000) {
  for (const until = Date.now() + ms; Date.now() < until;) {
    try { if ((await fetch(url, { signal: AbortSignal.timeout(2000) })).status < 500) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/** The vault's API. It never returns a value: list gives names, sites and where each came from. */
export function vaultClient(url = process.env.VAULT_URL || "http://vault:8932") {
  const call = async (method, p, body) => {
    let res;
    try {
      res = await fetch(url + p, {
        method, headers: body ? { "Content-Type": "application/json" } : {}, body: body && JSON.stringify(body), signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw Object.assign(new Error("The vault isn't running: the human should check the claude-agents-vault container (its logs), or redeploy the stack"), { code: 503 });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `The vault answered ${res.status}`), { code: res.status < 500 ? res.status : 502 });
    return data;
  };
  return {
    /** { logins: [{ name, site, source: "vault"|"stack", updatedAt, agents }], sites: [{ rule, source }] } */
    list: () => call("GET", "/logins"),
    /** grant: agents that may use it from now on (added to those that already may). */
    save: (name, value, site, grant = []) => call("PUT", `/logins/${name}`, { value, site, grant }),
    /** Exactly these agents may use the login (also one from BROWSER_SECRETS). */
    grant: (name, agents) => call("POST", `/grants/${name}`, { agents }),
    remove: (name) => call("DELETE", `/logins/${name}`),
    /** Let the browser open a site, or stop it ({ add } or { remove }: a rule as siteRule takes it). */
    sites: (change) => call("POST", "/sites", change),
  };
}
