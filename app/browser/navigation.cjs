// Loaded by the browser's MCP server for every tab (--init-page), inside the browser container.
//
// The browser opens pages only on the sites you allowed (BROWSER_SITES: origins like https://www.olx.pt,
// hosts like vinted.pt, or *.vinted.pt for every subdomain). A page on an allowed site loads whatever it
// needs (images, scripts, sign-in frames) from anywhere on the internet, but never from the internal
// network (the vault, the app, the browser itself) or a bare IP address, except the devices on your network you
// let this agent's browser reach (approved in the chat) (BROWSER_LAN), which go through the LAN gateway.

const sites = (process.env.BROWSER_SITES || "").split(";").map((s) => s.trim().toLowerCase()).filter(Boolean);
// The devices on your network this agent's browser may open (the guard reads them from the LAN gateway, which also
// enforces them): [{ host, port, tls, mode }]. Only these private addresses go anywhere; the proxy setting sends them
// to the gateway, never straight out.
let devices = [];
try { devices = JSON.parse(process.env.BROWSER_LAN || "[]"); } catch { devices = []; }

const allowed = (url) => sites.some((r) => r === url.origin || r === url.hostname
  || (r.startsWith("*.") && url.hostname.endsWith(r.slice(1))));
const portOf = (url) => Number(url.port || (url.protocol === "https:" ? 443 : 80));
const deviceFor = (url) => devices.find((d) => d.host === url.hostname && d.port === portOf(url));

// No dot (docker service names, localhost), IP literals and local-only suffixes.
const internal = (host) => !host.includes(".") || /^[\d.]+$/.test(host) || host.startsWith("[")
  || /\.(localhost|local|internal|lan|home\.arpa)$/.test(host);

const routed = new WeakSet();

exports.default = async ({ page }) => { // Playwright calls the default export
  const context = page.context();
  if (routed.has(context)) return; // one rule per browser context covers its tabs and popups
  routed.add(context);
  await context.route("**", (route) => {
    const request = route.request();
    let url;
    try { url = new URL(request.url()); } catch { return route.abort("blockedbyclient"); }
    if (!/^https?:$/.test(url.protocol)) return route.abort("blockedbyclient");
    const device = deviceFor(url);
    if (device) {
      // A device that speaks https is opened as http://: the gateway does the https (its certificate is often self-signed).
      if (url.protocol === "https:" && device.tls) {
        url.protocol = "http:";
        return route.fulfill({ status: 307, headers: { location: url.href.replace(/^http:\/\/([^/]+)/, `http://${device.host}:${device.port}`) } });
      }
      return route.continue();
    }
    if (internal(url.hostname)) return route.abort("blockedbyclient");
    const topLevel = request.isNavigationRequest() && !request.frame().parentFrame();
    if (topLevel && !allowed(url)) return route.abort("blockedbyclient");
    return route.continue();
  });
};
