// Delegation: an agent hands a task to another agent and carries on. The task runs in the background
// (several at once, one per agent), and the delegator checks on it (check_tasks) or waits for it
// (wait_for_tasks), both in agents-tool.mjs.
//
//   - each task runs as a normal run of the other agent (trigger "task:<id>"), started by an agent,
//     so it can't delegate or ask further agents itself (no chains, no loops)
//   - the task and its result also show in the other agent's chat, and every step is in the audit log
//   - a busy agent gets the task once it's free (waits up to TASK_WAIT_MS)
//   - results the delegator never collected come back to it in one follow-up run once all its tasks
//     have ended, so it can tell the human. That run can't delegate again.

const TASK_WAIT_MS = 15 * 60e3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param runAgent (name, opts) => Promise<outcome>, the engine's
 * @param post     (chat, role, author, text, { meta }) => message: adds a chat message (and shows it live)
 * @param isRunning (name) => boolean
 */
export function createTasks({ store, runAgent, post, isRunning, log }) {
  const pending = new Set(); // tasks and follow-ups in flight (the CLI waits for them before it exits)
  const following = new Set(); // delegators getting a follow-up run right now

  function track(p) {
    pending.add(p);
    p.catch((e) => log("tasks", `ERROR: ${e.message}`)).finally(() => pending.delete(p));
    return p;
  }

  async function run(id) {
    const t = store.task(id);
    for (const until = Date.now() + TASK_WAIT_MS; isRunning(t.to) && Date.now() < until;) await sleep(3000);
    store.startTask(id);
    post(t.to, "system", "system", `${t.from} gave you task #${id}: ${t.text}`);
    const r = await runAgent(t.to, {
      trigger: `task:${id}`, depth: 1,
      message: `Task #${id} from agent "${t.from}":\n\n${t.text}\n\n` +
        `Do it within your own job. Your reply is the result: it goes back to ${t.from}, so make it complete and self-contained.`,
    });
    if (!r.busy) post(t.to, "agent", t.to, r.result, { meta: { model: r.model, effort: r.effort, turns: r.turns, ok: r.ok, task: true, taskFrom: t.from, taskId: id } });
    store.endTask(id, r.ok && !r.busy, r.busy ? `${t.to} stayed busy, so the task didn't run.` : r.result);
    settle(t.from);
  }

  /** A delegator's tasks that ended without it collecting the results: give them back in one follow-up run. */
  function settle(from) {
    const { finished, pending: open } = store.unreportedTasks(from);
    if (open || !finished.length || following.has(from) || isRunning(from) || !store.get(from)?.enabled) return;
    following.add(from);
    store.markTasksReported(finished.map((t) => t.id));
    track((async () => {
      try {
        const lines = finished.map((t) => `## Task #${t.id} to ${t.to}: ${t.status === "done" ? "done" : "failed"}\nTask: ${t.text}\nResult:\n${t.result}`);
        const r = await runAgent(from, {
          trigger: "tasks", depth: 1,
          message: `The tasks you delegated have ended. Their results:\n\n${lines.join("\n\n")}\n\n` +
            "Tell the human what came back: a short summary with anything they need to decide or do. Don't delegate again.",
        });
        if (!r.busy) post(from, "agent", from, r.result, { meta: { model: r.model, effort: r.effort, turns: r.turns, ok: r.ok, task: true, tasks: finished.map((t) => t.id) } });
      } finally { following.delete(from); }
    })());
  }

  return {
    /** Create a task and start it in the background. Returns its id. */
    delegate(from, to, text) {
      const id = store.createTask(from, to, text);
      track(run(id).catch((e) => { store.endTask(id, false, `Error: ${e.message}`); throw e; }));
      return id;
    },
    /** After any run of an agent: results it left uncollected come back now. */
    afterRun: (name) => setTimeout(() => settle(name), 0),
    idle: () => Promise.all([...pending]),
  };
}
