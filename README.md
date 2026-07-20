# iterate tasks

A Kanban board over the `tasks/` folder of any iterate project's config repo —
deployed as a **stateless vessel** at `tasks.iterate.workers.dev`. It never
holds project secrets or user sessions of its own. Every useful request
arrives through a reverse proxy in the project's `/repos/config` worker on a
host like `tasks--<slug>.iterate.app`.

Per connection the vessel:

1. Reads the trusted `x-itx-project-id` header and the platform's
   `iterate-project-auth` cookie (forwarded by the proxy).
2. Opens a Cap'n Web WebSocket to `os.iterate.com/api` and authenticates with
   `{ type: "project-app-session", token }`.
3. Reads/writes `tasks/` markdown in `/repos/config` via `listTaskFiles` /
   `commitFiles` — the git history of the config repo *is* the board's
   history, attributed to the connected user.

There is no pairing form, no OIDC client, no DO storage, and no capability
door. One in-memory Durable Object per project (named by project id) fans
live state out to every open browser; when nobody is connected it is idle.

## Using it

Add a `tasks` app branch to the project's config `worker.ts` that gates on
project membership and reverse-proxies this vessel:

```ts
// tasks app — reverse-proxy the vessel at tasks.iterate.workers.dev
export class TasksApp extends IterateWorkerEntrypoint {
  async fetch(req: Request): Promise<Response> {
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
}
```

Wire that class into the project's app router the same way as the seeded
`HelloApp` / `InternalApp` examples. Then open
`https://tasks--<slug>.iterate.app/` — sign-in is the platform's project-
member gate; the board UI is this app at `/`.

Drag cards, add tasks, click a card to edit its markdown. Every change is a
commit to `/repos/config`. The board also re-reads the repo every 30s while
someone is connected, so commits from elsewhere (dashboard, agent) show up.

Hitting `tasks.iterate.workers.dev` directly serves only a landing page with
the same proxy snippet — no project context, no board.

## Development

```bash
pnpm install
cp .dev.vars.example .dev.vars   # point OS_BASE_URL at a local os dev server
pnpm dev
```

Locally you still need to stamp `x-itx-project-id` and a valid
`iterate-project-auth` cookie on requests (a small proxy, or
`scripts/probe-board-authed.mjs`) — the vessel does not mint sessions.

## Deployment

```bash
pnpm run deploy   # vite build && wrangler deploy
```

No secrets. The only var is `OS_BASE_URL` (defaults to `https://os.iterate.com`
in `wrangler.jsonc`).
