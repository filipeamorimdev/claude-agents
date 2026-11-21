// Auto-approval: rules that let one agent run certain commands without asking you each time (run_command).
//
// Off by default: an agent with no rules asks for every command. You add rules per agent (UI or CLI); agents can't.
//   exact   the command must be exactly this, e.g. "df -h"
//   prefix  the command must start with this, e.g. "git status" or "lan curl -s http://192.168.1.50:8123/api/"
//   lan     what an auto-approved command may reach on your network: "none" (default), "read" (GET only) or "full",
//           never more than the targets you granted the agent (lan.mjs)
//
// Read-only commands (also off by default, a switch per agent): with it on, a command that only reads runs without
// asking, no rule needed:
//   - in its own folder: ls, cat, grep, find, jq, wc... (READ_ONLY below), with no network at all (no "..", "~",
//     absolute paths outside it, /tmp, which every agent's commands share, globs that climb out, or a symlink that
//     leads out of it)
//   - on a device you granted it: `lan-ssh <device> <read-only command>` (cat, ls, df, systemctl status, journalctl,
//     docker ps, ip addr...: REMOTE_READ_ONLY) and `lan curl http://<device>/...` (GET only). Not with --sudo, and not
//     when a word points at private data there (keys, passwords, tokens, .env, shadow...: PRIVATE_WORD)
// Anything else still asks: a command that writes, deletes or installs, restarts or changes a device, private data,
// anything that reaches the internet, git, sed, awk, scripts.
//
// A command is auto-approved when an exact rule is that whole command, character for character (any command: a
// script with ; | $(...) too, e.g. from "Always allow this command"), or when it is plain: no ; & > < ( ) newline,
// no $ or ` outside single quotes (so no chaining, redirects, subshells or substitutions), and what follows a prefix
// rule is plain words only: no quotes, backslashes or globs (PLAIN_REST). A pipeline (a | b | c) is auto-approved only
// when every part matches a rule; its LAN access is the least any of its prefix rules gives. Anything else asks you.
// Some commands never run without you, whatever the rules say: anything that mentions the log, the database,
// the agents CLI or purging. Auto-approved commands are logged like any other, marked with the rule that let them run.

import { realpathSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { privateIPv4 } from "./address.mjs";

export const RULE_KINDS = ["exact", "prefix"];
export const RULE_LAN = ["none", "read", "full"];
// As long as a command may be (COMMAND_MAX in shell.mjs), so "Always allow" works on any command an agent can run.
export const PATTERN_MAX = 2000;

/** Never auto-approved, whatever the rules say: these always wait for you. */
const NEVER = /\bagents\b|\bpurge\b|agent_log|agents\.db|\/data\b|\/run\/control|\blogs?\b.*\b(rm|delete|truncate)\b/i;

/**
 * The parts of a plain pipeline ("a | b"), or null when the command chains, redirects or substitutes anything.
 * Quotes are respected: inside single quotes everything is text; inside double quotes only $ and ` are special.
 */
export function pipelineParts(cmd) {
  const s = String(cmd ?? "");
  const parts = [];
  let cur = "", quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote === "'") { if (c === "'") quote = null; cur += c; continue; }
    if (c === "\\") { if (i + 1 >= s.length || s[i + 1] === "\n") return null; cur += c + s[++i]; continue; }
    if (c === "$" || c === "`") return null;
    if (quote === '"') { if (c === '"') quote = null; cur += c; continue; }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
    if (";&<>()\n\r{}".includes(c)) return null;
    if (c === "|") {
      if (s[i + 1] === "|") return null;
      parts.push(cur.trim()); cur = ""; continue;
    }
    cur += c;
  }
  if (quote) return null;
  parts.push(cur.trim());
  return parts.every(Boolean) ? parts.map((p) => p.replace(/\s+/g, " ")) : null;
}

/** Validate a rule from the UI or CLI. Returns { errors, rule }. */
export function validateRule({ kind = "exact", pattern = "", lan = "none", note = "" } = {}) {
  const errors = [];
  const raw = String(pattern ?? "").trim();
  const plain = pipelineParts(raw)?.length === 1;
  // An exact rule for anything but one plain command (a script, a pipeline, $(...)) is kept as typed, and matches only
  // that text, character for character (see autoApproval).
  const p = plain || kind !== "exact" ? raw.replace(/\s+/g, " ") : raw;
  if (!RULE_KINDS.includes(kind)) errors.push('kind: "exact" or "prefix"');
  if (!RULE_LAN.includes(lan)) errors.push('lan: "none", "read" or "full"');
  if (!p) errors.push("pattern: the command (or its start)");
  else if (p.length > PATTERN_MAX) errors.push(`pattern: at most ${PATTERN_MAX} characters`);
  else if (kind === "prefix" && !plain) errors.push("pattern: a \"starts with\" rule is one plain command, without ; & | > < $ ` ( ) or line breaks (an exact rule can be anything)");
  else if (NEVER.test(p)) errors.push("pattern: commands about the log, the database, the agents CLI or purging always need your OK");
  else if (kind === "prefix" && p.length < 2) errors.push("pattern: a prefix of at least 2 characters");
  return { errors, rule: { kind, pattern: p, lan, note: String(note ?? "").replace(/\s+/g, " ").trim().slice(0, 200) } };
}

// Commands that only read and print. Each maps to a check of its arguments (words, unquoted): false = not read-only.
// Left out on purpose: anything that can write a file or run another program from its arguments or config
// (sed -i / w, awk system(), git hooks and pager, env CMD, xargs, tee, curl -o...), and anything that reaches a network.
// A one-letter option is refused wherever it sits in a group of them: "-uo" is "-u -o". (A group can also be one option
// and its value, "-k2o": refused too, which only costs an ask.)
const hasOpt = (x, b) => x === b || x.startsWith(`${b}=`) || (/^-[^-]$/.test(b) && /^-[^-]/.test(x) && x.slice(1).includes(b[1]));
const noOpt = (...bad) => (w) => !w.some((x) => bad.some((b) => hasOpt(x, b)));
const any = () => true;
// --files0-from=F reads the names of the files to open from F, where no path check sees them.
const LISTS = ["--files0-from"];
// Options that follow symlinks found inside a folder (the paths named on the command line are checked, these aren't).
const both = (...checks) => (w) => checks.every((c) => c(w));
const READ_ONLY = {
  ls: (w) => !(w.some((x) => hasOpt(x, "-R") || x === "--recursive") && w.some((x) => hasOpt(x, "-L") || x === "--dereference")),
  cat: any, head: any, tail: any, wc: noOpt(...LISTS), stat: any, du: noOpt(...LISTS, "-L", "--dereference"), df: any, pwd: any, echo: any, printf: any,
  whoami: any, id: any, uname: any, printenv: any, which: any, cut: any, tr: any, nl: any, column: any, basename: any,
  // A checksum file (-c) names the files to read.
  dirname: any, realpath: any, readlink: any, md5sum: noOpt("-c", "--check"), sha1sum: noOpt("-c", "--check"),
  sha256sum: noOpt("-c", "--check"), sha512sum: noOpt("-c", "--check"), cksum: noOpt("-c", "--check"),
  cmp: any, diff: noOpt("-r", "--recursive", "--from-file", "--to-file"), comm: any,
  grep: noOpt("-R", "--dereference-recursive"), egrep: noOpt("-R", "--dereference-recursive"), fgrep: noOpt("-R", "--dereference-recursive"),
  jq: any, rev: any, fold: any, paste: any,
  join: any, tac: any, od: any, hexdump: any, seq: any, true: any, false: any, uptime: any, free: any, ps: any,
  date: noOpt("-s", "--set"),
  file: noOpt("-C", "--compile"),
  tree: noOpt("-o", "-l", "--fromfile"),
  sort: noOpt("-o", "--output", "--compress-program", "-T", "--temporary-directory", ...LISTS),
  rg: noOpt("--pre", "-L", "--follow"),
  find: (w) => !w.some((x) => /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls|files0-from|L|H|follow)$/.test(x)),
  uniq: (w) => w.filter((x) => !x.startsWith("-")).length <= 1, // a second name is a file it writes
  hostname: both((w) => w.every((x) => x.startsWith("-")), noOpt("-F", "--file", "-b", "--boot")),
  env: (w) => w.length === 0, // env CMD runs CMD
};
/**
 * Shell words of one plain command, quotes removed (pipelineParts already refused $ ` ; & > < { } and the rest).
 * glob: the word has an unquoted * ? or [, which the shell expands into names.
 */
function words(part) {
  const out = []; let cur = null, q = null;
  for (let i = 0; i < part.length; i++) {
    const c = part[i];
    // As sh reads it: in double quotes a backslash escapes only $ ` " \ and a newline, and stays text before anything else.
    if (q === '"' && c === "\\" && i + 1 < part.length && '$`"\\\n'.includes(part[i + 1])) { cur.text += part[++i]; continue; }
    if (q) { if (c === q) q = null; else cur.text += c; continue; }
    cur ??= { text: "", glob: false };
    if (c === "'" || c === '"') { q = c; continue; }
    if (c === "\\") { cur.text += part[++i] ?? ""; continue; }
    if (c === " ") { if (cur.text || part[i - 1] === "'" || part[i - 1] === '"') out.push(cur); cur = null; continue; }
    if ("*?[".includes(c)) cur.glob = true;
    cur.text += c;
  }
  if (cur) out.push(cur);
  return out;
}
// The paths a word may name: itself, what follows = (--file=x), what follows a one-letter option (-fx).
const pathsOf = (w) => [w, ...(w.includes("=") ? [w.slice(w.indexOf("=") + 1)] : []), ...(/^-[A-Za-z]./.test(w) ? [w.slice(2)] : [])];
/** Whether a path stays in the agent's own folder: relative, no .., no ~, no glob that could climb out. */
function staysHome(p, glob, home) {
  if (p.startsWith("~")) return false;
  if (p.split("/").includes("..")) return false;
  // Not /tmp: every agent's commands share the sandbox's /tmp, so one agent could read what another left there.
  if (p.startsWith("/") && !(p === home || p.startsWith(`${home}/`))) return false;
  // A glob is expanded by the shell: "*.txt" is fine, ".?" is "..", "/w*/x" is anywhere.
  if (glob && (p.includes("/") || p.startsWith("."))) return false;
  return true;
}
/**
 * Whether a path, as the sandbox sees it, really stays in the folder once symlinks are followed. local: the same folder
 * as this container sees it. A path that doesn't exist (yet) is judged by the deepest part of it that does.
 */
function realStaysHome(p, home, local, localReal) {
  let full = p.startsWith("/") ? path.join(local, p.slice(home.length)) : path.join(local, p);
  while (!existsSync(full) && full !== local && full.startsWith(`${local}/`)) full = path.dirname(full);
  let real;
  try { real = realpathSync(full); } catch { return false; }
  return real === localReal || real.startsWith(`${localReal}/`);
}

/** Whether every entry of the folder (what a glob without "/" can match) stays in it once symlinks are followed. */
function entriesStayHome(local, localReal) {
  let names;
  try { names = readdirSync(local); } catch { return false; }
  return names.every((n) => realStaysHome(n, "", local, localReal));
}

/** Whether one part of a pipeline only reads inside the agent's own folder (see isReadOnly). Sets ctx.globbed. */
function localPartOk(part, home, local, localReal, ctx) {
  const ws = words(part);
  const [name, ...rest] = ws.map((w) => w.text);
  const check = Object.hasOwn(READ_ONLY, name ?? "") ? READ_ONLY[name] : null;
  if (!check || ws[0].glob || !check(rest)) return false;
  return ws.slice(1).every((w) => {
    ctx.globbed ||= w.glob;
    return pathsOf(w.text).every((p) => staysHome(p, w.glob, home) && (!local || w.glob || realStaysHome(p, home, local, localReal)));
  });
}

// ----- reading on a device you granted (lan-ssh) and from one (lan curl), with read-only commands on -----
// Words that point at private data on a device: these still ask, whatever the command. Matched on every word of the
// remote command (a path, a setting's name), so `cat /etc/shadow`, `cat ~/.ssh/id_rsa`, `cat app/.env`,
// `nvram get wl0_wpa_psk` or `cat /proc/1/environ` wait for you.
const PRIVATE_WORD = /shadow|sudoers|\.ssh\b|id_(rsa|dsa|ecdsa|ed25519)|authorized_keys|\.env\b|\.envrc|\.netrc|\.pgpass|\.my\.cnf|\.aws\b|\.kube\b|\.docker\b|\.gnupg|\.password-store|keyring|secret|token|passw|passphrase|\bpass\b|_pass|_pwd\b|\.pwd\b|credential|\bauth|private|\.(pem|p12|pfx|jks|kdbx)\b|keystore|wallet|environ\b|_history\b|\bhistory\b|psk|wpa|(^|[^a-z])keys?([^a-z]|$)|cookie|session|vault|backup|dump|\.sql\b|\.db\b|sqlite/i;
// The first word that isn't an option: a subcommand ("systemctl status", "docker ps").
const sub = (w) => w.find((x) => !x.startsWith("-"));
const subIn = (...ok) => (w) => !w[0]?.startsWith("-") && ok.includes(sub(w));
// On a device, the same READ_ONLY commands (paths may be anywhere there: reading the device is the point), minus the
// ones that print every environment variable or search whole trees (grep -r, rg) where private files hide, plus the
// usual looks at a machine's state. Each only reads; anything that changes state (systemctl restart, ip link set,
// docker rm, dmesg -c, ss -K, journalctl --vacuum...) is refused and asks.
const { env: _e, printenv: _p, rg: _r, ...REMOTE_BASE } = READ_ONLY;
const noRecurse = noOpt("-r", "-R", "--recursive", "--dereference-recursive", "-d", "--directories");
const REMOTE_READ_ONLY = {
  ...REMOTE_BASE,
  grep: noRecurse, egrep: noRecurse, fgrep: noRecurse,
  systemctl: (w) => ["status", "list-units", "list-unit-files", "list-timers", "list-sockets", "is-active", "is-enabled", "is-failed", "show"].includes(sub(w))
    && !w.some((x) => hasOpt(x, "-H") || hasOpt(x, "--host") || hasOpt(x, "-M") || hasOpt(x, "--machine")),
  journalctl: (w) => !w.some((x) => /^--(vacuum-|rotate|flush|sync|relinquish|smart-relinquish|setup-keys|update-catalog|file|directory|root|image)/.test(x) || hasOpt(x, "-D") || hasOpt(x, "-i")),
  docker: (w) => {
    if (w[0]?.startsWith("-")) return false; // -H another daemon, --config another config
    const [a, b] = w;
    if (["ps", "images", "version", "info", "logs", "top", "port", "stats"].includes(a)) return true;
    return (["container", "image", "network", "volume", "compose"].includes(a) && ["ls", "ps"].includes(b)) || (a === "system" && b === "df");
  },
  ip: (w) => !w.some((x) => /^(add|del|delete|set|flush|change|replace|append|prepend|restore|exec|netns|-b|-batch|-force|-n|-netns)$/.test(x)),
  ss: noOpt("-K", "--kill", "-D", "--diag", "-F", "--filter"), netstat: any,
  lsblk: any, lscpu: any, lsusb: any, lspci: any, lsmod: any, findmnt: any, nproc: any, arch: any, vmstat: any, iostat: any,
  mpstat: any, w: any, who: any, last: noOpt("-f"), lastlog: any, sensors: noOpt("-s", "--set", "-c", "--config-file"), pgrep: any, lsof: any,
  mount: (w) => w.length === 0 || (w.length === 1 && hasOpt(w[0], "-l")),
  dmesg: noOpt("-c", "-C", "--clear", "-n", "--console-level", "-D", "--console-off", "-E", "--console-on", "-F", "--file"),
  top: (w) => w.some((x) => hasOpt(x, "-b")),
  zpool: subIn("list", "status", "iostat"), zfs: subIn("list", "get"),
  nvram: (w) => w.length === 2 && w[0] === "get",
  dpkg: (w) => w.length >= 1 && ["-l", "--list", "-s", "--status", "-L", "--listfiles", "-S", "--search"].includes(w[0]),
  apt: subIn("list", "show", "policy", "search"), "apt-cache": subIn("show", "policy", "search", "showpkg", "depends", "rdepends"),
  uptime: any, free: any, df: any,
};
// What may follow `lan-ssh` in an auto-approved command: plain words only (like PLAIN_REST), because the device's shell
// reads the words again. No quotes, globs, ~ or $: the device would see a second command, or names from this sandbox.
const SSH_PLAIN = /^[A-Za-z0-9 _.,:=@%+/-]+$/;
/** `lan-ssh [-l user] [--login NAME] <device> <read-only command>`. --sudo (root on the device) always asks. */
function sshPartOk(part) {
  const rest = part.slice("lan-ssh ".length);
  if (!part.startsWith("lan-ssh ") || !SSH_PLAIN.test(rest)) return false;
  const w = rest.split(" ");
  while (w[0]?.startsWith("-")) {
    const flag = w.shift();
    if (flag === "--") break;
    if (!/^(-l|--user|--login)(=|$)/.test(flag)) return false; // --sudo, or anything lan-ssh doesn't know
    if (!flag.includes("=") && !w.shift()) return false;
  }
  const [device, name, ...args] = w;
  if (!device || !name) return false;
  const check = Object.hasOwn(REMOTE_READ_ONLY, name) ? REMOTE_READ_ONLY[name] : null;
  return !!check && check(args) && ![name, ...args].some((x) => PRIVATE_WORD.test(x));
}
// curl options that only shape a read: what to print, how long to wait, which headers to send. Not -o/-O/-D/-c (write
// files), -d/-F/-T/-X/--json (another method or an upload), -K (a config file), -x/--noproxy (around the gateway),
// -w (it can write files too), -b/-H @file (read a file into the request).
const CURL_FLAGS = /^(-[sSfLiIkvgG]+|--(silent|show-error|fail|fail-with-body|location|include|head|insecure|verbose|compressed|globoff|get|no-progress-meter|no-buffer|http1\.1))$/;
const CURL_VALUE = /^(-H|--header|-m|--max-time|--connect-timeout|-A|--user-agent|--max-redirs|--retry|--retry-delay|-e|--referer|-r|--range)$/;
/** An http:// address of a device on your network (the gateway lets through only the ones granted to the agent). */
const deviceUrl = (x) => { try { const u = new URL(x); return u.protocol === "http:" && !u.username && !u.password && privateIPv4(u.hostname); } catch { return false; } };
/** `lan curl <read options> http://<device>/...`: a GET (or HEAD), which the gateway also enforces (read-only token). */
function curlPartOk(part) {
  const ws = words(part);
  if (ws.length < 3 || ws[0].text !== "lan" || ws[1].text !== "curl" || ws.some((w) => w.glob)) return false;
  const w = ws.slice(2).map((x) => x.text);
  let urls = 0;
  for (let i = 0; i < w.length; i++) {
    const x = w[i];
    if (CURL_VALUE.test(x)) { const v = w[++i]; if (v == null || v.startsWith("@")) return false; continue; }
    if (x.startsWith("-")) { if (!CURL_FLAGS.test(x)) return false; continue; }
    if (!deviceUrl(x)) return false;
    urls++;
  }
  return urls > 0;
}

/**
 * Whether a command only reads, and what it needs to: { lan: "none" | "read" | "full" } or null (ask the human).
 * Every part of the pipeline is one of:
 *   - a READ_ONLY command in the agent's own folder (isReadOnly)
 *   - `lan-ssh <device> <command>` where the command only reads on the device (REMOTE_READ_ONLY) and names nothing
 *     private (PRIVATE_WORD), without --sudo. It needs full LAN access (the gateway runs ssh only for a device granted
 *     with full access), and the token can do nothing but this text, which was checked word by word
 *   - `lan curl <read options> http://<device>/...`: read LAN access (GET, HEAD, OPTIONS only, at the gateway)
 * The gateway still lets a command reach only the devices you granted this agent: this never adds a device.
 */
export function readOnlyApproval(cmd, agent, workspaces = "/workspaces", local = null) {
  const s = String(cmd ?? "").trim();
  if (!s || NEVER.test(s)) return null;
  const parts = pipelineParts(s);
  if (!parts) return null;
  const home = `${workspaces}/${agent}`;
  let localReal = null;
  if (local) { try { localReal = realpathSync(local); } catch { return null; } }
  const ctx = { globbed: false };
  let lan = "none";
  for (const part of parts) {
    if (sshPartOk(part)) lan = "full";
    else if (curlPartOk(part)) { if (lan === "none") lan = "read"; }
    else if (!localPartOk(part, home, local, localReal, ctx)) return null;
  }
  if (local && ctx.globbed && !entriesStayHome(local, localReal)) return null;
  return { lan };
}

/**
 * Whether a command only reads, inside the agent's own folder: every part of the pipeline is a READ_ONLY command whose
 * arguments pass its check, and no word points outside its folder (.., ~, an absolute path elsewhere, a climbing glob).
 * workspaces: where the agents' folders are in the command sandbox (shell.mjs).
 * local: the agent's folder as this container sees it. With it, symlinks are followed too: a word, or what a glob can
 * match, that leads out of the folder makes the command ask. Without it (tests of the text alone) they aren't.
 */
export function isReadOnly(cmd, agent, workspaces = "/workspaces", local = null) {
  return readOnlyApproval(cmd, agent, workspaces, local)?.lan === "none";
}

const LAN_ORDER = { none: 0, read: 1, full: 2 };
// What may follow a prefix: plain words only. No quotes, backslashes, globs or anything else a shell treats specially,
// because some commands hand their arguments to another shell: `lan-ssh router nvram get 'x; reboot'` (or ssh) runs
// `reboot` on the device, and `sh -c`, `env`, `xargs` or `find -exec` do the same locally. Quoting stays allowed in the
// approved prefix itself (e.g. -o ProxyCommand='lan-connect %h %p') and in exact rules, which run only the text you approved.
const PLAIN_REST = /^[A-Za-z0-9 _.,:=@%+/-]*$/;
// A prefix ends where a word ends: "ls" matches "ls -la", not "lsblk"; one ending in "/", ":" or "=" (a URL, an
// option) matches whatever follows it.
const matches = (rule, part) => rule.kind === "exact" ? part === rule.pattern
  : part === rule.pattern || (part.startsWith(rule.pattern) && (/[\s/:=]$/.test(rule.pattern) || part[rule.pattern.length] === " ")
    && PLAIN_REST.test(part.slice(rule.pattern.length)));

/**
 * Whether a command runs without asking. Returns { rules: [ids], lan } or null (ask the human).
 * rules: the agent's rules ({ id, kind, pattern, lan }).
 */
export function autoApproval(rules, cmd) {
  if (!rules?.length || NEVER.test(String(cmd ?? ""))) return null;
  // An exact rule matching the whole command as typed: it runs only the text you approved, whatever it holds.
  const whole = rules.find((r) => r.kind === "exact" && r.pattern === String(cmd).trim());
  if (whole) return { rules: [whole.id], lan: whole.lan };
  const parts = pipelineParts(String(cmd).trim());
  if (!parts) return null;
  const used = [];
  for (const part of parts) {
    // The most specific rule that matches: an exact one, else the longest prefix.
    const r = rules.filter((x) => matches(x, part)).sort((a, b) => (b.kind === "exact") - (a.kind === "exact") || b.pattern.length - a.pattern.length)[0];
    if (!r) return null;
    used.push(r);
  }
  // The LAN access is the least any prefix rule gives: an exact command does only what it says, so it doesn't count
  // (e.g. "jq ." after a "lan curl" with read access). Only exact rules: the most they give.
  const prefixes = used.filter((r) => r.kind === "prefix");
  const lan = prefixes.length ? prefixes.reduce((m, r) => (LAN_ORDER[r.lan] < LAN_ORDER[m] ? r.lan : m), "full")
    : used.reduce((m, r) => (LAN_ORDER[r.lan] > LAN_ORDER[m] ? r.lan : m), "none");
  return { rules: [...new Set(used.map((r) => r.id))], lan };
}
