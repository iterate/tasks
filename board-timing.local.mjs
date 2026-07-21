import { WebSocket as NodeWS } from "ws";
import { newWebSocketRpcSession } from "capnweb";
class A extends NodeWS { constructor(u,p){ super(u,p,{headers:{cookie:`iterate-project-auth=${process.env.T}`, "x-itx-project-id":"prj_16061809ad1e405fbe7d771b6468062d"}}); } }
globalThis.WebSocket = A;
const api = newWebSocketRpcSession("wss://tasks-collab-preview.iterate.workers.dev/api");
using project = await api.authenticate(process.env.T);
const ws = project.workspace("demo-board", "/repos/config");
const t0 = Date.now();
const files = await ws.files();
console.log("files():", Object.keys(files).length, "tasks in", Date.now() - t0, "ms");
process.exit(0);
