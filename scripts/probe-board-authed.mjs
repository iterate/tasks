// Deployed-lane probe: connect to a board WebSocket the way a browser does
// behind the project proxy. Headers must include the platform session cookie
// and the trusted project id (the proxy stamps both; for a headless probe you
// pass them yourself). Run from a directory whose node_modules has `ws` and
// `capnweb`.
//   node probe-board-authed.mjs <baseUrl> <projectId> <token> [title]
// Cookie: iterate-project-auth=<token>
// Header: x-itx-project-id=<projectId>
import { WebSocket } from "ws";
import { newWebSocketRpcSession } from "capnweb";

const [baseUrl, projectId, token, title = ""] = process.argv.slice(2);
if (!baseUrl || !projectId || !token) {
  throw new Error(
    "usage: probe-board-authed.mjs <baseUrl> <projectId> <token> [title]\n" +
      "  sends cookie iterate-project-auth=<token> and header x-itx-project-id",
  );
}
const url = new URL("/api/board", baseUrl);
url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

const socket = new WebSocket(url.toString(), {
  headers: {
    cookie: `iterate-project-auth=${token}`,
    "x-itx-project-id": projectId,
  },
  handshakeTimeout: 15_000,
});
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
  // The board API is one batched commit of file changes (the browser models
  // its working tree locally) — the probe commits a single new task file.
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "task";
  const path = `tasks/${slug}-probe-${Date.now()}.md`;
  const content = `---\nstate: todo\n---\n\n# ${title}\n\nFiled by the headless probe.\n`;
  const result = await session.commitChanges({
    message: `Add ${title} (probe)`,
    changes: [{ path, content }],
  });
  console.log("committed:", result);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  console.log("after:", JSON.stringify(summarize(latest), null, 2));
}
process.exit(0);
