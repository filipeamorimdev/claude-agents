#!/usr/bin/env node
// agents: manage the agent database.   docker exec -it claude-agents agents help

import path from "node:path";
import { openStore, validateAgent, diff, MODELS, EFFORTS } from "./store.mjs";
import { createInterface } from "node:readline/promises";
import { createEngine, loadConfig, purgeLogs } from "./engine.mjs";
import { createPairing, sendCode, checkCode, testDevice, deviceStatus } from "./notify.mjs";
import { lanClient } from "./lan.mjs";

const DATA_DIR = process.env.DATA_DIR || "/data";
const CONFIG_DIR = process.env.CONFIG_DIR || "/app/config";
const TZ = process.env.TZ || "UTC";
const HUMAN = "human (cli)";

const HELP = `agents: manage your agents

  agents list                      all agents
  agents show <name>               full config incl. prompt
  agents proposals [all]           changes suggested by agents (open by default)
  agents proposal <id>             one proposal with its diff
  agents approve <id>              apply a proposal
  agents reject <id>               reject a proposal
  agents set <name> model=<m> effort=<e>   e.g. model=opus effort=high, or model=gpt-6.1-sol
  agents enable <name>             enable an agent
  agents disable <name>            disable an agent
  agents delete <name>             delete an agent (its workspace files stay)
  agents run <name>                run an agent's task now
  agents ask <name> <message...>   ask an agent something directly
  agents import [file] [--only N]  add/update agents from config/agents.mjs (or file)
  agents export                    print all agents as JSON
  agents runs [name]               recent runs
  agents events                    audit log
  agents log [name] [--kind K] [--run ID] [--find TEXT] [-n N]
                                   everything agents did: requests, commands and other tool calls, what they said,
                                   results, changes (K: start, say, think, tool, result, refused, end, event)
  agents logs purge [--older-than DAYS] [--agent NAME]
                                   delete log entries and run log files. Logs are kept until you do this:
                                   nothing removes them automatically and agents can't. Asks you to confirm.

Commands an agent may run without asking you (none by default; each one is still logged, marked auto-approved):
  agents commands <name>           its rules
  agents commands <name> allow [--prefix] [--lan read|full] <command...>
                                   exactly this command (or, with --prefix, anything starting with it). --lan: what it
                                   may reach on your network when it runs that way (default: nothing)
  agents commands <name> read-only on|off
                                   commands that only read in its own folder (ls, cat, grep, find, jq…) run without
                                   asking; anything that writes, uses the network or leaves its folder still asks
  agents commands remove <id>      remove a rule: it asks again

Your home network (devices agents may reach: set them in the chat, house icon):
  agents lan                       every device and which agents may reach it

Push notifications (the browser's own, on phones and computers) when an agent run ends:
  agents devices                   devices that get them
  agents devices add <name>        a pairing code: on the device, open the chat and type /devices pair <code>
                                   (or there tap the bell next to "Agents" → Turn on notifications here)
  agents devices verify <name>     send the device a new "Confirm this device" notification...
  agents devices verify <name> <code>   ...tap it, or type its code: only confirmed devices get notifications
  agents devices test <name>       send a test notification
  agents devices remove <name>     stop notifying a device

Changes are picked up by the scheduler within ~10 seconds.
Use your ChatGPT plan for OpenAI models: codex login --device-auth`;

const store = openStore(path.join(DATA_DIR, "agents.db"));
const registry = (await loadConfig(CONFIG_DIR, "mcp-servers.mjs", "mcpServers")) ?? {};
const [cmd, ...args] = process.argv.slice(2);

const pad = (s, n) => String(s ?? "").padEnd(n).slice(0, n);
const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };
const need = (v, what) => v ?? fail(`missing ${what}. See: agents help`);
const showDiff = (d) => {
  for (const [k, { from, to }] of Object.entries(d)) {
    if (k === "prompt") console.log(`  prompt: ${from ? "changed" : "new"}\n${String(to).split("\n").map((l) => "    | " + l).join("\n")}`);
    else console.log(`  ${k}: ${JSON.stringify(from)} → ${JSON.stringify(to)}`);
  }
};

try {
  switch (cmd) {
    case "list": {
      const agents = store.list();
      const open = store.proposals("open").length;
      console.log(`${pad("NAME", 22)} ${pad("ON", 3)} ${pad("SCHEDULE", 14)} ${pad("MODEL", 7)} ${pad("EFFORT", 7)} TOOLS`);
      for (const a of agents) {
        console.log(`${pad(a.name, 22)} ${pad(a.enabled ? "✓" : "-", 3)} ${pad(a.schedule ?? "on demand", 14)} ${pad(a.model, 7)} ${pad(a.effort, 7)} ${a.tools.join(", ")}`);
      }
      if (open) console.log(`\n${open} open proposal(s): agents proposals`);
      break;
    }
    case "show": {
      const a = store.get(need(args[0], "name")) ?? fail(`no agent "${args[0]}"`);
      const { prompt, ...rest } = a;
      console.log(JSON.stringify(rest, null, 2));
      console.log(`\nprompt:\n${prompt}`);
      break;
    }
    case "proposals": {
      const list = store.proposals(args[0] === "all" ? "all" : "open");
      if (!list.length) { console.log("No open proposals."); break; }
      for (const p of list) {
        console.log(`#${p.id}  ${p.status.padEnd(8)} ${p.kind} "${p.agent}"  by ${p.proposed_by}  ${p.created_at.slice(0, 16)}`);
        if (p.reason) console.log(`     reason: ${p.reason}`);
      }
      console.log("\nDetails: agents proposal <id>   Apply: agents approve <id>");
      break;
    }
    case "proposal": {
      const p = store.proposal(Number(need(args[0], "id"))) ?? fail(`no proposal #${args[0]}`);
      console.log(`#${p.id} ${p.kind} "${p.agent}" by ${p.proposed_by} (${p.status})\nreason: ${p.reason || "-"}\n`);
      showDiff(diff(store.get(p.agent), p.status === "open" ? store.proposed(p) : p.config)); // an open one: what approving applies now
      break;
    }
    case "approve":
    case "reject": {
      const id = Number(need(args[0], "proposal id"));
      const before = store.get(store.proposal(id)?.agent ?? fail(`no proposal #${args[0]}`));
      const p = store.decide(id, cmd === "approve", HUMAN, registry);
      if (cmd === "approve") {
        console.log(`✓ approved #${id}: ${p.kind} "${p.agent}"`);
        showDiff(diff(before, store.get(p.agent)));
      } else console.log(`✓ rejected #${id}`);
      break;
    }
    case "set": {
      const name = need(args[0], "name");
      const kv = Object.fromEntries(args.slice(1).map((x) => x.split("=")));
      if (!kv.model && !kv.effort) fail(`usage: agents set ${name} model=<${MODELS.join("|")}> effort=<${Object.keys(EFFORTS).join("|")}>`);
      const changed = store.setSettings(name, { model: kv.model, effort: kv.effort }, HUMAN);
      const a = store.get(name);
      console.log(changed ? `✓ ${name}: ${a.model}, ${a.effort} effort (≤${a.maxTurns} turns)` : "= unchanged");
      break;
    }
    case "enable":
    case "disable":
      store.setEnabled(need(args[0], "name"), cmd === "enable", HUMAN);
      console.log(`✓ ${args[0]} ${cmd}d`);
      break;
    case "delete":
      store.remove(need(args[0], "name"), HUMAN);
      console.log(`✓ deleted ${args[0]} (workspace files in ${DATA_DIR}/workspaces/${args[0]} kept)`);
      break;
    case "run":
    case "ask": {
      const name = need(args[0], "name");
      const message = cmd === "ask" ? need(args.slice(1).join(" ") || null, "message") : null;
      const log = (n, m) => console.error(`  [${n}] ${m}`);
      const engine = createEngine({ store, registry, dataDir: DATA_DIR, tz: TZ, log });
      const r = await engine.runAgent(name, { trigger: cmd === "ask" ? "ask:human" : "manual", message });
      console.log(`\n${r.result}`);
      const open = store.proposals("open");
      if (open.length) console.log(`\n${open.length} open proposal(s). Review: agents proposals`);
      process.exitCode = r.ok ? 0 : 1;
      await engine.idle();
      break;
    }
    case "devices": {
      const [sub = "list", name, code] = args;
      const get = () => store.device(need(name, "device name")) ?? fail(`no device "${name}". See: agents devices`);
      switch (sub) {
        case "list": case "ls": {
          const list = store.devices();
          if (!list.length) { console.log("No devices yet. In the chat on the device, tap the bell next to \"Agents\", or: agents devices add <name>"); break; }
          console.log(`${pad("NAME", 16)} ${pad("STATUS", 26)} ${pad("PLATFORM", 22)} LAST NOTIFICATION`);
          for (const d of list) {
            const last = d.lastSentAt ? `${d.lastSentAt.slice(0, 16).replace("T", " ")} ${d.lastError ? `✗ ${d.lastError}` : "✓"}` : "-";
            console.log(`${pad(d.name, 16)} ${pad(deviceStatus(d), 26)} ${pad(d.platform || "-", 22)} ${last}`);
          }
          if (list.some((d) => !d.verifiedAt)) console.log("\nOnly confirmed devices get notifications.");
          break;
        }
        case "add": case "create": {
          const pair = createPairing(store, need(name, "device name"), HUMAN);
          console.log(`✓ added ${name}. Pairing code (valid 15 minutes):  ${pair}

  On the device, open the chat (sign in), then type in the search box:  /devices pair ${pair}
  iPhone/iPad: first tap Share → Add to Home Screen and open the chat from there.
  The chat must be on https:// (or localhost) for the browser to allow notifications.
  The device then gets a "Confirm this device" notification: tap it.`);
          break;
        }
        case "verify": {
          const d = get();
          if (d.verifiedAt) { console.log(`= ${d.name} is already confirmed. Send a test: agents devices test ${d.name}`); break; }
          if (!d.endpoint) fail(`${d.name} isn't connected yet: turn notifications on in the chat on that device`);
          if (code) {
            checkCode(store, d.name, code, HUMAN);
            console.log(`✓ ${d.name} confirmed: it gets a notification whenever an agent run ends`);
          } else {
            await sendCode(store, d.name);
            console.log(`✓ sent "Confirm this device" to ${d.name} (valid 15 minutes). Tap it there, or: agents devices verify ${d.name} <code>`);
          }
          break;
        }
        case "test":
          await testDevice(store, get().name);
          console.log(`✓ sent a test notification to ${name}`);
          break;
        case "remove": case "rm": case "delete":
          store.removeDevice(need(name, "device name"), HUMAN);
          console.log(`✓ removed ${name}: it gets no more notifications`);
          break;
        default:
          fail(`unknown "devices ${sub}". See: agents help`);
      }
      break;
    }
    case "import": {
      const onlyIdx = args.indexOf("--only");
      const only = onlyIdx !== -1 ? need(args[onlyIdx + 1], "agent name after --only") : null;
      const fileArg = args.find((a, i) => !a.startsWith("--") && (onlyIdx === -1 || i !== onlyIdx + 1));
      const file = fileArg ? path.resolve(fileArg) : path.join(CONFIG_DIR, "agents.mjs");
      const { agents } = await import(file);
      for (const cfg of agents.filter((a) => !only || a.name === only)) {
        const { errors, agent } = validateAgent(cfg, "human", registry);
        if (errors.length) { console.log(`✗ ${cfg.name}: ${errors.join("; ")}`); continue; }
        const existed = store.get(agent.name);
        if (existed && !Object.keys(diff(existed, agent)).length) { console.log(`= ${agent.name} unchanged`); continue; }
        store.upsert(agent, `${HUMAN} import`);
        console.log(`✓ ${existed ? "updated" : "added"} ${agent.name}`);
      }
      break;
    }
    case "export":
      console.log(JSON.stringify(store.list().map(({ createdBy, createdAt, updatedAt, ...a }) => a), null, 2));
      break;
    case "runs":
      for (const r of store.runs(args[0])) {
        console.log(`${r.started_at.slice(0, 16)}  ${pad(r.agent, 20)} ${pad(r.trigger, 18)} ${pad(r.status ?? "running", 8)} ${r.turns ?? "-"} turns  ${(r.result ?? "").replace(/\s+/g, " ").slice(0, 60)}`);
      }
      break;
    case "log": {
      const opt = (flag) => { const i = args.indexOf(flag); return i === -1 ? null : need(args[i + 1], `a value after ${flag}`); };
      const flagged = new Set(["--kind", "--run", "--find", "-n"].flatMap((f) => { const i = args.indexOf(f); return i === -1 ? [] : [i, i + 1]; }));
      const name = args.find((a, i) => !flagged.has(i)) ?? null;
      const kind = opt("--kind"), run = opt("--run"), n = Number(opt("-n") ?? 50);
      const rows = store.logPage({ agent: name, kinds: kind ? kind.split(",") : null, run: run ? Number(run) : null, q: opt("--find"), limit: n > 0 ? n : 50 });
      for (const r of rows.reverse()) {
        console.log(`${r.at.slice(0, 19).replace("T", " ")}  ${pad(r.agent ?? r.actor ?? "", 18)} ${pad(r.run ? `#${r.run}` : "", 6)} ${pad(r.kind, 8)} ${r.text.slice(0, 200)}`);
      }
      if (!rows.length) console.log("Nothing in the log.");
      break;
    }
    case "logs": {
      if (args[0] !== "purge") fail(`unknown "logs ${args[0] ?? ""}". See: agents help`);
      const opt = (flag) => { const i = args.indexOf(flag); return i === -1 ? null : need(args[i + 1], `a value after ${flag}`); };
      const days = opt("--older-than"), agent = opt("--agent");
      // Purging is the human's: it needs a person at a terminal, and it refuses to run from inside an agent's run.
      if (process.env.AGENT_RUN) fail("agents can't purge the log");
      if (!process.stdin.isTTY || !process.stdout.isTTY) fail("purging needs you at a terminal: docker exec -it claude-agents agents logs purge");
      const { entries, oldest } = store.logStats();
      const what = `${days ? `log entries and run log files older than ${days} days` : "ALL log entries and run log files"}${agent ? ` of ${agent}` : ""}`;
      console.log(`The log has ${entries} entries${oldest ? `, the oldest from ${oldest.slice(0, 10)}` : ""}.`);
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question(`Delete ${what}? This can't be undone. Type "purge" to confirm: `);
      rl.close();
      if (answer.trim() !== "purge") { console.log("Nothing was deleted."); break; }
      const r = await purgeLogs(store, DATA_DIR, { days: days ? Number(days) : null, agent }, HUMAN);
      console.log(`✓ purged ${r.entries} log entries and ${r.files} run log file(s). The audit log (agents events) keeps a record of this.`);
      break;
    }
    case "commands": {
      if (process.env.AGENT_RUN) fail("agents can't change which commands run without asking");
      const [first, sub, ...rest] = args;
      if (first === "remove") {
        const r = store.removeCommandRule(Number(need(sub, "rule id")), HUMAN);
        console.log(`✓ removed rule #${r.id} of ${r.agent}: it asks again for \`${r.pattern}\``);
        break;
      }
      const name = need(first, "agent name");
      if (!store.get(name)) fail(`no agent "${name}"`);
      if (sub === "read-only") {
        const on = need(rest[0], "on or off");
        if (!["on", "off"].includes(on)) fail("read-only: on or off");
        store.setReadOnlyCommands(name, on === "on", HUMAN);
        console.log(on === "on" ? `✓ ${name} runs read-only commands (ls, cat, grep, find…) in its folder without asking` : `✓ ${name} asks again before read-only commands`);
        break;
      }
      if (sub === "allow") {
        let kind = "exact", lan = "none";
        const words = [];
        for (let i = 0; i < rest.length; i++) {
          if (rest[i] === "--prefix") kind = "prefix";
          else if (rest[i] === "--lan") lan = need(rest[++i], "read or full after --lan");
          else words.push(rest[i]);
        }
        const id = store.addCommandRule(name, { kind, pattern: need(words.join(" ") || null, "the command"), lan }, HUMAN);
        console.log(`✓ rule #${id}: ${name} runs ${kind === "exact" ? "exactly" : "anything starting with"} \`${words.join(" ")}\` without asking` +
          `${lan === "none" ? "" : ` (network: ${lan === "read" ? "read-only" : "full"})`}`);
        break;
      }
      if (sub) fail(`unknown "commands ${name} ${sub}". See: agents help`);
      const list = store.commandRules(name);
      const ro = store.get(name).readOnlyCommands;
      console.log(`read-only commands without asking: ${ro ? "on" : "off"}`);
      if (!list.length) { console.log(ro ? `No rules: ${name} asks before every command that isn't read-only.` : `${name} asks you before every command.`); break; }
      for (const r of list) console.log(`#${String(r.id).padEnd(4)} ${pad(r.kind, 7)} ${pad(`lan:${r.lan}`, 9)} ${r.pattern}`);
      break;
    }
    case "lan": {
      const { targets, grants } = await lanClient().state();
      if (!targets.length) { console.log("No devices: no agent can reach your network. Add them in the chat (house icon)."); break; }
      for (const t of targets) {
        const who = Object.entries(grants).filter(([, g]) => g[t.id]).map(([a, g]) => `${a} (${g[t.id] === "full" && t.mode === "full" ? "full" : "read-only"})`);
        console.log(`${pad(t.id, 18)} ${pad(`${t.host}:${t.port}`, 22)} ${pad(t.mode === "full" ? "full ok" : "read-only", 10)} ${pad(t.credential ? `key: ${t.credential.header}` : "no key", 22)} ${pad(t.ssh ? `ssh: ${t.ssh.user}` : "", 16)} ${who.join(", ") || "no agent"}`);
      }
      break;
    }
    case "events":
      for (const e of store.events()) console.log(`${e.at.slice(0, 16)}  ${pad(e.actor, 34)} ${pad(e.action, 15)} ${e.agent ?? ""}`);
      break;
    default:
      console.log(HELP);
  }
} catch (e) {
  fail(e.message);
} finally {
  store.close();
}
