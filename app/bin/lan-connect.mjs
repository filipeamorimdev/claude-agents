#!/usr/bin/env node
// lan-connect <host> <port>: a TCP connection through the LAN gateway on stdin/stdout, for ssh's ProxyCommand or as nc.
// Only a device this agent may reach with full access; only inside a command given network access (LAN_PROXY).
import net from "node:net";

const [host, port] = process.argv.slice(2);
const fail = (m, code = 1) => { process.stderr.write(`lan-connect: ${m}\n`); process.exit(code); };
if (!host || !/^\d+$/.test(port ?? "")) fail("usage: lan-connect <host> <port>", 2);
if (!process.env.LAN_PROXY) fail("this command has no access to your network", 3);
const proxy = new URL(process.env.LAN_PROXY);
const auth = Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64");
const s = net.connect({ host: proxy.hostname, port: Number(proxy.port) }, () => {
  s.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`);
});
let head = Buffer.alloc(0);
const onData = (c) => {
  head = Buffer.concat([head, c]);
  const end = head.indexOf("\r\n\r\n");
  if (end === -1) { if (head.length > 8192) fail("bad answer from the gateway"); return; }
  const status = head.subarray(0, head.indexOf("\r\n")).toString();
  const body = head.subarray(end + 4).toString().trim().replace(/^lan: /, "");
  if (!/^HTTP\/1\.[01] 200/.test(status)) fail(body || status.replace(/^HTTP\/1\.[01] \d+ /, ""));
  s.off("data", onData);
  const rest = head.subarray(end + 4);
  if (rest.length) process.stdout.write(rest);
  s.pipe(process.stdout);
  process.stdin.pipe(s);
};
s.on("data", onData);
s.on("error", (e) => fail(e.message));
s.on("end", () => process.exit(0));
