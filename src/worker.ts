import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { env as workerEnv } from "cloudflare:workers";
import { newWorkersWebSocketRpcResponse } from "capnweb";
import { getServerByName } from "partyserver";
import type { TasksBoardDurableObject } from "./board-do.ts";
import type { TasksCheckoutDurableObject } from "./checkout-do.ts";
import type { AppEnv } from "./board-do.ts";
import { TasksApiRoot, type VesselEnv } from "./rpc-api.ts";
import { isCheckoutId, normalizeRepoPath } from "./lib/checkout-shared.ts";

export { TasksBoardDurableObject } from "./board-do.ts";
export { TasksCheckoutDurableObject } from "./checkout-do.ts";
export { TasksCheckoutIndexDurableObject } from "./checkout-index-do.ts";

// wrangler.jsonc declares exactly these; the app is small enough that a
// hand-written env type beats generated worker configuration types.
const env = workerEnv as unknown as VesselEnv & {
  BOARD: DurableObjectNamespace<TasksBoardDurableObject>;
};

const PROJECT_ID_HEADER = "x-itx-project-id";

/**
 * Landing page for direct hits on the vessel host (no proxy headers). The
 * app is only useful behind a project's config-worker reverse proxy — this
 * page tells operators exactly what to paste into that worker.
 */
function landingPage(): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Iterate Tasks</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: #0b0d10;
      color: #e6e8eb;
      font-family: system-ui, sans-serif;
      font-size: 14px;
      line-height: 1.5;
    }
    main { max-width: 44rem; margin: 3rem auto; padding: 0 1.25rem; }
    h1 { font-size: 1.4rem; margin: 0 0 0.5rem; }
    p { color: #9aa3ad; margin: 0 0 1rem; }
    code, pre { font-family: ui-monospace, monospace; }
    code { color: #e6e8eb; }
    pre {
      overflow-x: auto;
      background: #14171b;
      border: 1px solid #2a2f36;
      border-radius: 8px;
      padding: 1rem;
      font-size: 0.8rem;
      color: #e6e8eb;
      line-height: 1.45;
    }
    a { color: #e6e8eb; }
  </style>
</head>
<body>
  <main>
    <h1>Iterate Tasks</h1>
    <p>
      This app is a <strong style="color:#e6e8eb;font-weight:600">stateless vessel</strong>.
      It only ever runs behind a reverse proxy served by an iterate project&rsquo;s
      own <code>/repos/config</code> worker, on a project host like
      <code>tasks--&lt;slug&gt;.iterate.app</code>. Direct traffic here has no
      project context and no session cookie, so there is nothing to show.
    </p>
    <p>
      Add a <code>tasks</code> app branch to your project&rsquo;s config
      <code>worker.ts</code> that gates on project membership, rewrites the
      request to this host, and stamps the project id:
    </p>
    <pre>// tasks app — reverse-proxy the vessel at tasks.iterate.workers.dev
export class TasksApp extends IterateWorkerEntrypoint {
  async fetch(req: Request): Promise&lt;Response&gt; {
    using itx = await this.env.ITX.get();

    // (a) project-member auth gate — return its response when non-null
    const auth = await itx.auth.get({ policy: "project-member" }).fetch(req);
    if (auth) return auth;

    // (b) transparent proxy: pages, assets, and WebSocket upgrades
    const description = await itx.__describe();
    const url = new URL(req.url);
    url.protocol = "https:";
    url.host = "tasks.iterate.workers.dev";
    const headers = new Headers(req.headers);
    headers.set("x-itx-project-id", description.projectId);
    return fetch(new Request(url, {
      method: req.method,
      headers,
      body: req.body,
      redirect: "manual",
    }));
  }
}</pre>
    <p>
      The platform forwards the user&rsquo;s short-lived session as the
      <code>iterate-project-auth</code> cookie; this vessel authenticates to
      <code>os.iterate.com</code> with that token per WebSocket connection.
      No secrets are stored here.
    </p>
  </main>
</body>
</html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

export default createServerEntry({
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") {
      return new Response("ok", { headers: { "content-type": "text/plain" } });
    }

    // The vessel's ONE api root: a Cap'n Web WebSocket session. It sits
    // before the project-header gate on purpose: agents and services dial
    // the vessel host directly and authenticate with an explicit credential
    // (whose own project claim scopes the session), while proxied browser
    // traffic authenticates via the cookie riding its upgrade.
    if (url.pathname === "/api") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("capnweb WebSocket only — upgrade required", { status: 426 });
      }
      return newWorkersWebSocketRpcResponse(request, new TasksApiRoot(env, request));
    }

    const projectId = request.headers.get(PROJECT_ID_HEADER);

    // No project header → this is a direct hit on the vessel host, not
    // proxied project traffic. Serve only the static landing page.
    if (!projectId) {
      return landingPage();
    }

    // The Yjs lane: y-protocols sync + awareness for one checkout, kept off
    // /api because it's binary y-websocket wire, not capnweb. One DO per
    // (project, repo, checkout id) — the repo rides as ?repoPath= and is
    // bound into the DO name.
    const yjs = /^\/yjs\/([^/]+)$/.exec(url.pathname);
    if (yjs) {
      const checkoutId = decodeURIComponent(yjs[1]!);
      const repoPath = normalizeRepoPath(url.searchParams.get("repoPath"));
      if (!isCheckoutId(checkoutId) || repoPath === null) {
        return new Response("bad checkout id or repo path", { status: 400 });
      }
      const stub = await getServerByName(
        env.CHECKOUT as unknown as Parameters<typeof getServerByName>[0],
        `${projectId}:${repoPath}:${checkoutId}`,
      );
      return stub.fetch(request);
    }

    return handler.fetch(request);
  },
});
