// Auto-approval: rules that let one agent run certain commands without asking you each time (run_command).
//
// Off by default: an agent with no rules asks for every command. You add rules per agent (UI or CLI); agents can't.
//   exact   the command must be exactly this, e.g. "df -h"
//   prefix  the command must start with this, e.g. "git status" or "lan curl -s http://192.168.1.50:8123/api/"
//   lan     what an auto-approved command may reach on your network: "none" (default), "read" (GET only) or "full",
//           never more than the targets you granted the agent (lan.mjs)
//
// Read-only commands (also off by default, a switch per agent): with it on, a command that only reads runs without
// asking, no rule needed: ls, cat, grep, find, jq, wc... (READ_ONLY below), with no network at all, only in its own
// folder (no "..", "~", absolute paths outside it or globs that climb out). Anything else still asks: a command that writes, deletes or
// installs, anything that reaches the network or your devices (curl, lan, ssh), git, sed, awk, scripts.
//
// A command is auto-approved only when it is plain: no ; & > < ( ) newline, no $ or ` outside single quotes
// (so no chaining, redirects, subshells or substitutions), and what follows a prefix rule is plain words only: no
// quotes, backslashes or globs (PLAIN_REST). A pipeline (a | b | c) is auto-approved only when
// every part matches a rule; its LAN access is the least any of its prefix rules gives. Anything else asks you.
// Some commands never run without you, whatever the rules say: anything that mentions the log, the database,
// the agents CLI or purging. Auto-approved commands are logged like any other, marked with the rule that let them run.

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
  const p = String(pattern ?? "").trim().replace(/\s+/g, " ");
  if (!RULE_KINDS.includes(kind)) errors.push('kind: "exact" or "prefix"');
  if (!RULE_LAN.includes(lan)) errors.push('lan: "none", "read" or "full"');
  if (!p) errors.push("pattern: the command (or its start)");
  else if (p.length > PATTERN_MAX) errors.push(`pattern: at most ${PATTERN_MAX} characters`);
  else if (pipelineParts(p)?.length !== 1) errors.push("pattern: one plain command, without ; & | > < $ ` ( ) or line breaks");
  else if (NEVER.test(p)) errors.push("pattern: commands about the log, the database, the agents CLI or purging always need your OK");
  else if (kind === "prefix" && p.length < 2) errors.push("pattern: a prefix of at least 2 characters");
  return { errors, rule: { kind, pattern: p, lan, note: String(note ?? "").replace(/\s+/g, " ").trim().slice(0, 200) } };
}

// Commands that only read and print. Each maps to a check of its arguments (words, unquoted): false = not read-only.
// Left out on purpose: anything that can write a file or run another program from its arguments or config
// (sed -i / w, awk system(), git hooks and pager, env CMD, xargs, tee, curl -o...), and anything that reaches a network.
const noOpt = (...bad) => (w) => !w.some((x) => bad.some((b) => x === b || x.startsWith(`${b}=`) || (b.length === 2 && !b.startsWith("--") && x.startsWith(b))));
const any = () => true;
const READ_ONLY = {
  ls: any, cat: any, head: any, tail: any, wc: any, stat: any, du: any, df: any, pwd: any, echo: any, printf: any,
  whoami: any, id: any, uname: any, printenv: any, which: any, cut: any, tr: any, nl: any, column: any, basename: any,
  dirname: any, realpath: any, readlink: any, md5sum: any, sha1sum: any, sha256sum: any, sha512sum: any, cksum: any,
  cmp: any, diff: any, comm: any, grep: any, egrep: any, fgrep: any, jq: any, rev: any, fold: any, paste: any,
  join: any, tac: any, od: any, hexdump: any, seq: any, true: any, false: any, uptime: any, free: any, ps: any,
  date: noOpt("-s", "--set"),
  file: noOpt("-C", "--compile"),
  tree: noOpt("-o"),
  sort: noOpt("-o", "--output", "--compress-program"),
  rg: noOpt("--pre"),
  find: (w) => !w.some((x) => /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(x)),
  uniq: (w) => w.filter((x) => !x.startsWith("-")).length <= 1, // a second name is a file it writes
  hostname: (w) => w.every((x) => x.startsWith("-") && !/^-(F|-file|b|-boot)/.test(x)),
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
/** Whether a path stays in the agent's own folder (or /tmp): relative, no .., no ~, no glob that could climb out. */
function staysHome(p, glob, home) {
  if (p.startsWith("~")) return false;
  if (p.split("/").includes("..")) return false;
  if (p.startsWith("/") && !(p === home || p.startsWith(`${home}/`) || p === "/tmp" || p.startsWith("/tmp/"))) return false;
  // A glob is expanded by the shell: "*.txt" is fine, ".?" is "..", "/w*/x" is anywhere.
  if (glob && (p.includes("/") || p.startsWith("."))) return false;
  return true;
}
/**
 * Whether a command only reads, inside the agent's own folder: every part of the pipeline is a READ_ONLY command whose
 * arguments pass its check, and no word points outside its folder (.., ~, an absolute path elsewhere, a climbing glob).
 * workspaces: where the agents' folders are in the command sandbox (shell.mjs).
 */
export function isReadOnly(cmd, agent, workspaces = "/workspaces") {
  const s = String(cmd ?? "").trim();
  if (!s || NEVER.test(s)) return false;
  const parts = pipelineParts(s);
  if (!parts) return false;
  const home = `${workspaces}/${agent}`;
  return parts.every((part) => {
    const ws = words(part);
    const [name, ...rest] = ws.map((w) => w.text);
    const check = Object.hasOwn(READ_ONLY, name ?? "") ? READ_ONLY[name] : null;
    return Boolean(check && !ws[0].glob && check(rest) && ws.slice(1).every((w) => pathsOf(w.text).every((p) => staysHome(p, w.glob, home))));
  });
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
