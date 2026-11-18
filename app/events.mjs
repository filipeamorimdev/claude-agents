// One-line, human-readable descriptions of audit events, used for docker logs and the chat's Activity view.

const one = (s, n = 300) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const tools = (t) => (t?.length ? t.join(", ") : "none");
const RUN_TRIGGERS = { schedule: "scheduled", manual: "run now", chat: "chat", "ask:human": "CLI", login: "after a login", tasks: "tasks came back" };
const runTrigger = (t = "") => RUN_TRIGGERS[t] ?? (t.startsWith("agent:") ? `asked by ${t.slice(6)}` : t.startsWith("group:") ? "group chat"
  : t.startsWith("webhook:") ? `webhook "${t.slice(8)}"` : t.startsWith("task:") ? `task #${t.slice(5)}` : t);

export function describeEvent(e) {
  const d = e.details ?? {};
  switch (e.action) {
    case "create":
      return `${e.actor} created agent "${e.agent}" (${d.model}/${d.effort}, ${d.schedule ?? "on demand"}, tools: ${tools(d.tools)})`;
    case "update":
      return `${e.actor} updated "${e.agent}": ${Object.keys(d).join(", ") || "no changes"}`;
    case "settings":
      return `${e.actor} set "${e.agent}" to ${Object.entries(d).map(([k, v]) => `${k} ${v.from}→${v.to}`).join(", ")}`;
    case "propose-create":
      return `${e.actor} proposed NEW agent "${e.agent}" (#${d.proposal}, ${d.model}/${d.effort}, ${d.schedule ?? "on demand"}, tools: ${tools(d.tools)}): ${one(d.reason, 200)}`;
    case "propose-update":
      return `${e.actor} proposed changes to "${e.agent}" (#${d.proposal}): ${one(d.reason, 200)}`;
    case "approve":
      return `${e.actor} approved proposal #${d.proposal} for "${e.agent}" (from ${d.proposed_by})`;
    case "reject":
      return `${e.actor} rejected proposal #${d.proposal} for "${e.agent}" (from ${d.proposed_by})`;
    case "ask":
      return `${e.actor} → ${e.agent}: ${one(d.message)}`;
    case "reply":
      return `${e.actor} → ${e.agent} (reply): ${one(d.reply)}`;
    case "group-create":
      return `${e.actor} created group "${d.name}" with ${tools(d.members)}`;
    case "group-update":
      return `${e.actor} updated group "${d.name}"${d.added?.length ? `, added ${d.added.join(", ")}` : ""}${d.removed?.length ? `, removed ${d.removed.join(", ")}` : ""}`;
    case "group-delete":
      return `${e.actor} deleted group "${d.name}"`;
    case "device-add":
      return `${e.actor} added push device "${d.device}"${d.pairing ? ", waiting for pairing" : ""}`;
    case "device-connect":
      return `${e.actor} turned on notifications for "${d.device}"${d.platform ? ` (${d.platform})` : ""}, waiting for confirmation`;
    case "device-verify":
      return `${e.actor} confirmed push device "${d.device}"`;
    case "device-disconnect":
      return `push device "${d.device}" turned notifications off; turn them on again on that device`;
    case "device-remove":
      return `${e.actor} removed push device "${d.device}"`;
    case "login-request":
      return `${e.actor} asked for a login for ${d.site} (${tools(d.names)})${d.reason ? `: ${one(d.reason, 200)}` : ""}`;
    case "login-save":
      return `${e.actor} saved ${d.names?.length ? tools(d.names) : "nothing new"} in the vault${d.site ? ` for ${d.site}` : ""}` +
        `${e.agent ? ` for ${e.agent}` : d.agents?.length ? ` for ${tools(d.agents)}` : ""}`;
    case "login-dismiss":
      return `${e.actor} dismissed ${e.agent}'s login request for ${d.site}`;
    case "login-grant":
      return `${e.actor} let ${d.agents?.length ? tools(d.agents) : "no agent"} use ${tools(d.names)}`;
    case "login-delete":
      return `${e.actor} deleted ${tools(d.names)} from the vault`;
    case "site-allow":
      return `${e.actor} let the browser open ${d.site}`;
    case "site-remove":
      return `${e.actor} stopped the browser opening ${d.site}`;
    case "site-note":
      return d.note ? `${e.actor} described ${d.site}: ${one(d.note, 200)}` : `${e.actor} removed the description of ${d.site}`;
    case "lan-ssh":
      return d.removed ? `${e.actor} removed the SSH key of ${d.name ?? d.id}`
        : `${e.actor} ${d.generated ? "generated" : "saved"} an SSH key for ${d.name ?? d.id} (user ${d.user}, ${d.fingerprint})`;
    case "lan-host-key":
      return `${e.actor} reset the SSH host key of ${d.name ?? d.id}: the next ssh trusts the key it presents`;
    case "lan-note":
      return d.note ? `${e.actor} described the network target ${d.name ?? d.id}: ${one(d.note, 200)}` : `${e.actor} removed the description of ${d.name ?? d.id}`;
    case "enable": case "disable": case "delete":
      return `${e.actor} ${e.action}d "${e.agent}"`;
    case "run":
      return `${e.agent} ran (${runTrigger(d.trigger)}): ${d.status ?? "?"}${d.turns ? `, ${d.turns} turns` : ""}${d.seconds != null ? `, ${d.seconds}s` : ""}`;
    case "rule":
      return `${e.actor} set ${e.agent} to ${d.to === "ask" ? "ask first before" : d.to === "allow" ? "always use" : "the default for"} ${d.tool}`;
    case "action-request":
      return `${e.actor} ${d.kind === "tool" ? `asked to use ${d.tool}` : d.kind === "takeover" ? "asked you to take over its browser" : d.tool === "LAN" ? "asked to reach a device on your network" : d.tool === "LAN_KEY" ? "asked for a device's key" : "asked for your OK"}: ${one(d.title, 200)}`;
    case "action-allowed":
      return `${e.actor} allowed ${e.agent}: ${one(d.title, 200)}`;
    case "action-denied":
      return `${e.actor} declined ${e.agent}'s request: ${one(d.title, 200)}${d.note ? ` (${one(d.note, 200)})` : ""}`;
    case "action-done":
      return `${e.actor} handed ${e.agent}'s browser back${d.note ? `: ${one(d.note, 200)}` : ""}`;
    case "action-expired":
      return `${e.agent}'s request got no answer in time: ${one(d.title, 200)}`;
    case "memory-add":
      return `${e.actor} added a note to ${e.agent}'s memory: ${one(d.text, 200)}`;
    case "memory-edit":
      return `${e.actor} edited a note in ${e.agent}'s memory: ${one(d.text, 200)}`;
    case "memory-delete":
      return `${e.actor} removed a note from ${e.agent}'s memory: ${one(d.text, 200)}`;
    case "trigger-add":
      return `${e.actor} created webhook "${d.name}" for ${e.agent}`;
    case "trigger-enable": case "trigger-disable":
      return `${e.actor} turned webhook "${d.name}" of ${e.agent} ${e.action === "trigger-enable" ? "on" : "off"}`;
    case "trigger-remove":
      return `${e.actor} deleted webhook "${d.name}" of ${e.agent}`;
    case "trigger-fire":
      return `webhook "${d.name}" started ${e.agent}${d.bytes != null ? ` (${d.bytes} bytes${d.from ? ` from ${d.from}` : ""})` : ""}`;
    case "task-create":
      return `${e.actor} gave ${e.agent} task #${d.task}: ${one(d.text, 200)}`;
    case "task-start":
      return `${e.actor} started task #${d.task} from ${e.agent}`;
    case "task-done": case "task-fail":
      return `${e.actor} ${e.action === "task-done" ? "finished" : "couldn't finish"} task #${d.task} from ${e.agent}: ${one(d.result, 200)}`;
    case "log-purge":
      return `${e.actor} purged the log${e.agent ? ` of ${e.agent}` : ""}: ${d.entries ?? 0} entries` +
        `${d.files != null ? ` and ${d.files} run log file(s)` : ""}${d.before ? ` from before ${String(d.before).slice(0, 10)}` : ""}`;
    case "command-rule":
      return `${e.actor} ${d.changed ? "changed a rule" : "let"} ${e.agent} run ${d.kind === "exact" ? "exactly" : "commands starting with"} \`${one(d.pattern, 200)}\` without asking` +
        `${d.lan && d.lan !== "none" ? ` (LAN: ${d.lan === "read" ? "read-only" : "full"})` : ""}`;
    case "command-rule-remove":
      return `${e.actor} removed ${e.agent}'s rule for \`${one(d.pattern, 200)}\`: it asks again`;
    case "lan-target":
      return `${e.actor} ${d.removed ? "removed the network target" : "saved the network target"} ${d.name ?? d.id}${d.removed ? "" : ` (${d.host}:${d.port}, ${d.mode === "full" ? "full access" : "read-only"}${d.tls ? ", https" : ""})`}`;
    case "lan-credential":
      return `${e.actor} ${d.removed ? "removed the credential of" : "saved a credential for"} ${d.name ?? d.id}${d.header ? ` (${d.header})` : ""}`;
    case "lan-grant":
      return `${e.actor} let ${e.agent} reach ${d.targets?.length ? d.targets.map((t) => `${t.id} (${t.mode === "full" ? "full" : "read-only"}${t.browser ? ", browser too" : ""})`).join(", ") : "nothing on your network"}`;
    case "browser-control":
      return `${e.actor} took control of ${e.agent}'s browser`;
    default:
      return `${e.actor} ${e.action} ${e.agent ?? ""}`.trim();
  }
}
