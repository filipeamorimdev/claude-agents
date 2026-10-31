// One-line, human-readable descriptions of audit events, used for docker logs.

const one = (s, n = 300) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const tools = (t) => (t?.length ? t.join(", ") : "none");

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
    case "enable": case "disable": case "delete":
      return `${e.actor} ${e.action}d "${e.agent}"`;
    default:
      return `${e.actor} ${e.action} ${e.agent ?? ""}`.trim();
  }
}
