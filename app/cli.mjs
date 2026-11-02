#!/usr/bin/env node
// agents: manage the agent database.   docker exec -it claude-agents agents help

import path from "node:path";
import { openStore, validateAgent, diff, MODELS, EFFORTS } from "./store.mjs";
import { createEngine, loadConfig } from "./engine.mjs";
import { createPairing, sendCode, checkCode, testDevice, deviceStatus } from "./notify.mjs";

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
      showDiff(diff(store.get(p.agent), p.config));
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
