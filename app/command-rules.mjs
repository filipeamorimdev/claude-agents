// Auto-approval: rules that let one agent run certain commands without asking you each time (run_command).
//
// Off by default: an agent with no rules asks for every command. You add rules per agent (UI or CLI); agents can't.
//   exact   the command must be exactly this, e.g. "df -h"
//   prefix  the command must start with this, e.g. "git status" or "lan curl -s http://192.168.1.50:8123/api/"
//   lan     what an auto-approved command may reach on your network: "none" (default), "read" (GET only) or "full",
//           never more than the targets you granted the agent (lan.mjs)
//
// A command is auto-approved only when it is plain: no ; & > < ( ) newline, no $ or ` outside single quotes
// (so no chaining, redirects, subshells or substitutions), and what follows a prefix rule is plain words only: no
// quotes, backslashes or globs (PLAIN_REST). A pipeline (a | b | c) is auto-approved only when
// every part matches a rule; its LAN access is the least any of its prefix rules gives. Anything else asks you.
// Some commands never run without you, whatever the rules say: anything that mentions the log, the database,
// the agents CLI or purging. Auto-approved commands are logged like any other, marked with the rule that let them run.

export const RULE_KINDS = ["exact", "prefix"];
export const RULE_LAN = ["none", "read", "full"];
export const RULES_MAX = 50;
export const AUTO_PER_HOUR = 60;
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
