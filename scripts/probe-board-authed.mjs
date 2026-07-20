// Deployed-lane probe: connect to a board with a session cookie on the
// upgrade (the way the browser does, but headless). Run from a directory
// whose node_modules has `ws` and `capnweb`.
//   node probe-board-authed.mjs <baseUrl> <ref> <cookie> [title]
import { WebSocket } from "ws";
import { newWebSocketRpcSession } from "capnweb";

const [baseUrl, ref, cookie, title = ""] = process.argv.slice(2);
if (!baseUrl || !ref || !cookie) throw new Error("usage: probe-board-authed.mjs <baseUrl> <ref> <cookie> [title]");
const url = new URL(`/api/board/${ref}`, baseUrl);
url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

const socket = new WebSocket(url.toString(), { headers: { cookie }, handshakeTimeout: 15_000 });
const session = newWebSocketRpcSession(socket);
let latest;
await session.liveState.subscribe((update) => {
  if (update && typeof update === "object" && "snapshot" in update) latest = update.snapshot;
});
await new Promise((resolve) => setTimeout(resolve, 1000));
const summarize = (state) => ({
  status: state?.status,
  error: state?.error,
  commit: state?.commitOid?.slice(0, 7),
  tasks: state?.tasks?.map((task) => `${task.state}: ${task.title}`),
});
console.log("board:", JSON.stringify(summarize(latest), null, 2));
if (title) {
  const added = await session.addTask({ title, state: "todo", body: "Filed by the headless probe." });
  console.log("added:", added);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  console.log("after:", JSON.stringify(summarize(latest), null, 2));
}
process.exit(0);
