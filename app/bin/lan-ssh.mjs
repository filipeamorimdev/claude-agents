#!/usr/bin/env node
// lan-ssh [-l user] [--login NAME] [--sudo NAME] <device> <command...>: run one command on a device of your network
// over ssh, through the LAN gateway.
//   lan-ssh router nvram get productid                         (device: its name from network_access, its IP, or IP:port)
//   lan-ssh -l admin --login ROUTER_PASSWORD router uptime     (with a vault login for that device instead of a key)
//   lan-ssh -l admin --login PI_PASSWORD --sudo PI_PASSWORD pi apt-get update   (as root, with sudo on the device)
// The gateway signs in with the device's SSH key, which it keeps, or with a password from the vault that the human
// saved for this device and granted to this agent, and types --sudo's password into sudo's prompt: this command (and
// the agent) never sees any of them.
// Only a device this agent may reach with full access, inside a command given network access.
// Like ssh, the words after the device are joined with spaces and run by the device's shell. Exits with its exit code.

const fail = (m, code = 255) => { process.stderr.write(`lan-ssh: ${m}\n`); process.exit(code); };
const USAGE = "usage: lan-ssh [-l user] [--login NAME] [--sudo NAME] <device> <command...>   e.g. lan-ssh router nvram get productid";
const args = process.argv.slice(2);
let user = "", login = "", sudo = "";
while (args[0]?.startsWith("-")) {
  const flag = args.shift();
  if (flag === "--") break;
  const v = flag.includes("=") ? flag.slice(flag.indexOf("=") + 1) : args.shift();
  if (v == null || v === "") fail(USAGE, 2);
  if (flag === "-l" || flag.startsWith("--user")) user = v;
  else if (flag.startsWith("--login")) login = v;
  else if (flag.startsWith("--sudo")) sudo = v;
  else fail(`unknown option ${flag}\n${USAGE}`, 2);
}
const [device, ...words] = args;
if (!device || !words.length) fail(USAGE, 2);
if (!process.env.LAN_PROXY) fail("this command has no access to your network (no device was granted to this agent, or its approval gave none)");

(async () => {
  const proxy = new URL(process.env.LAN_PROXY);
  const auth = Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64");
  let res;
  try {
    res = await fetch(`http://${proxy.host}/ssh`, {
      method: "POST", headers: { "Content-Type": "application/json", "Proxy-Authorization": `Basic ${auth}` },
      body: JSON.stringify({ target: device, command: words.join(" "), ...(user ? { user } : {}), ...(login ? { login } : {}), ...(sudo ? { sudo } : {}) }),
    });
  } catch (e) { fail(`can't reach the LAN gateway: ${e.cause?.message ?? e.message}`); }
  const r = await res.json().catch(() => ({}));
  if (!res.ok) fail(r.error || `the gateway answered ${res.status}`);
  process.stdout.write(r.output ?? "");
  if (r.timedOut) fail("time is up: the command was stopped");
  process.exit(Number.isInteger(r.exitCode) ? r.exitCode : 255);
})();
