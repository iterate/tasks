// Dev probe: connect to a board the way the browser does and exercise the
// verbs. Usage: node scripts/probe-board.mjs [baseUrl] [projectRef] [title]
import { newWebSocketRpcSession } from "capnweb";

const [baseUrl = "http://localhost:5175", ref = "tasks-proof", title = ""] = process.argv.slice(2);
const url = new URL(`/api/board/${ref}`, baseUrl);
url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

const session = newWebSocketRpcSession(url.toString());
let latest;
await session.liveState.subscribe((update) => {
  if (update.snapshot !== undefined) latest = update.snapshot;
  // Patches only matter to real clients; the probe resubscribes for snapshots.
});
const summarize = (state) => ({
  status: state?.status,
  error: state?.error,
  commit: state?.commitOid?.slice(0, 7),
  tasks: state?.tasks.map((task) => `${task.state}: ${task.title} (${task.path})`),
});
await new Promise((resolve) => setTimeout(resolve, 500));
console.log("board:", JSON.stringify(summarize(latest), null, 2));

if (title) {
  const added = await session.addTask({ title, state: "todo", body: "Filed by probe-board.mjs." });
  console.log("added:", added);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  console.log("board after add:", JSON.stringify(summarize(latest), null, 2));
}
process.exit(0);
