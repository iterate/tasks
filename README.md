# iterate tasks

A Kanban board over the `tasks/` folder of any iterate project's config repo —
and a working example of an **independently deployed web app** that mutually
authenticates with the iterate platform. It runs at
`tasks.iterate.workers.dev`, deployed from this repo with plain
`wrangler deploy`; nothing about it lives inside the platform.

Every board is one Durable Object that sits on both ends of the loop:

- **Inbound** — it connects to `os.iterate.com/api` *as the project*, using
  the project API key every project is born with
  (`/secrets/project-api-key`, revealed once by a human and pasted into the
  pairing form). Tasks are read with `repos.get("/repos/config").listTaskFiles()`
  and every board action (drag, add, edit, delete) is one
  `commitFiles(...)` — the git history of your config repo *is* the board's
  history, and the same files render in the os dashboard's task view.
- **Outbound** — the platform can mount the board back as an itx capability
  (`itx.tasks.add("…")`) through `remoteCapability`, dialing
  `wss://tasks.iterate.workers.dev/capability/<project>` with a capability
  key this app mints at pairing time. Agents can file tasks onto the board
  without ever holding the project API key.

Humans sign in with their iterate account: the app is an ordinary OIDC client
of `auth.iterate.com` (authorization code + PKCE), with its own HMAC-signed
session cookie. The project API key never reaches a browser.

## Using it

1. Sign in at the app with your iterate account.
2. Open `/p/<anything>` — the ref names the board (use your project slug).
3. Pair once: enter the project id (`prj_…`) and the project API key
   (dashboard → your project → `/secrets` → `project-api-key` → Reveal).
   The app verifies the key by reading the config repo before storing it.
4. Drag cards, add tasks, click a card to edit its markdown. Every change is
   a commit to `/repos/config`; the board also re-reads the repo every 30s,
   so commits from anywhere else (the dashboard, an agent) show up too.

To let the platform file tasks (`itx.tasks.add`), take the capability key
shown on the board page and run this **from an in-scope project script** (an
agent script, or wrapped in `itx.capabilityHosts.get("/").runScript(...)` —
a mount provided directly from an external client session is revoked when
that session closes, because `provideCapability` returns an ownership handle
that revokes on disposal):

```ts
await itx.secrets.get("/secrets/tasks-app").create({
  egress: { urls: ["https://tasks.iterate.workers.dev"] },
  material: { apiKey: "<capability key>" },
});
await itx.capabilityHosts.get("/").provideCapability({
  type: "itx-expression",
  path: ["tasks"],
  expression: [
    "remoteCapability",
    [
      "get",
      "wss://tasks.iterate.workers.dev/capability/<project>",
      {
        headers: {
          authorization: 'Bearer getSecret({ path: "/secrets/tasks-app", field: "apiKey" })',
        },
      },
    ],
  ],
  instructions: "The project's Kanban task board. tasks.add(title, body?) files a task; tasks.list() reads the board.",
});
```

## Development

```bash
pnpm install
cp .dev.vars.example .dev.vars   # point OS_BASE_URL at a local os dev server
pnpm dev
```

`.dev.vars` with `DEV_ALLOW_ANONYMOUS=1` skips sign-in locally (there is no
local auth.iterate.com); everything else — pairing, commits, live state —
works against a local `pnpm dev` instance of the os app.

## Deployment

```bash
pnpm run deploy                       # vite build && wrangler deploy
wrangler secret put SESSION_SECRET    # any long random string
wrangler secret put AUTH_CLIENT_SECRET
```

`AUTH_CLIENT_ID` (a `vars` entry) comes from registering the app as an OAuth
client at auth.iterate.com (`POST /api/auth/oauth2/register`, session-authenticated)
with redirect URI `https://tasks.iterate.workers.dev/auth/callback`.
