import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { env as workerEnv } from "cloudflare:workers";
import type { TasksBoardDurableObject } from "./board-do.ts";
import { finishLogin, logout, sessionFromRequest, startLogin } from "./session.ts";
import type { AppEnv } from "./session.ts";

export { TasksBoardDurableObject } from "./board-do.ts";

// wrangler.jsonc declares exactly these; the app is small enough that a
// hand-written env type beats generated worker configuration types.
const env = workerEnv as unknown as AppEnv & {
  BOARD: DurableObjectNamespace<TasksBoardDurableObject>;
};

// Project refs share one grammar with state.ts normalizeProjectRef; the
// regexes only gate obviously-bogus DO names.
const BOARD_ROUTE = /^\/api\/(board|pair|capability-key)\/([a-z0-9_-]{1,80})$/;
const CAPABILITY_ROUTE = /^\/capability\/([a-z0-9_-]{1,80})$/;

export default createServerEntry({
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/auth/login") return startLogin(env, request);
    if (url.pathname === "/auth/callback") return finishLogin(env, request);
    if (url.pathname === "/auth/logout") return logout();

    if (url.pathname === "/api/me") {
      const user = await sessionFromRequest(env, request);
      return user
        ? Response.json({ user })
        : new Response("signed out", { status: 401 });
    }

    // The platform's door: bearer capability key, verified inside the DO —
    // no user cookie involved.
    const capabilityMatch = CAPABILITY_ROUTE.exec(url.pathname);
    if (capabilityMatch) {
      return env.BOARD.getByName(capabilityMatch[1]!).fetch(request);
    }

    // Human doors: board WebSocket, pairing, capability-key reveal — all
    // require a signed-in iterate user (auth.iterate.com), checked here so the
    // DO can trust x-tasks-user.
    const boardMatch = BOARD_ROUTE.exec(url.pathname);
    if (boardMatch) {
      const user = await sessionFromRequest(env, request);
      if (!user) return new Response("sign in first", { status: 403 });
      const forwarded = new Request(request, { headers: new Headers(request.headers) });
      forwarded.headers.set("x-tasks-user", user.email);
      return env.BOARD.getByName(boardMatch[2]!).fetch(forwarded);
    }

    if (url.pathname === "/api/health") {
      return new Response("ok", { headers: { "content-type": "text/plain" } });
    }

    // Everything else is the TanStack Start app: SSR routes + client assets.
    return handler.fetch(request);
  },
});
