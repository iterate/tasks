/**
 * Sign-in with iterate: a hand-rolled OIDC authorization-code client against
 * auth.iterate.com (issuer AUTH_ISSUER, endpoints `${issuer}/oauth2/*` per its
 * discovery document) plus HMAC-signed cookie sessions. No auth library — the
 * flow is three fetches and workerd's crypto.subtle covers the signing.
 */

export type AppEnv = {
  BOARD: DurableObjectNamespace;
  OS_BASE_URL: string;
  AUTH_ISSUER: string;
  AUTH_CLIENT_ID: string;
  /** wrangler secret */
  AUTH_CLIENT_SECRET?: string;
  /** wrangler secret; sessions are unforgeable only if this is set and random */
  SESSION_SECRET?: string;
  PUBLIC_BASE_URL: string;
  /** Local dev only: skip sign-in entirely and act as a fixed dev user. */
  DEV_ALLOW_ANONYMOUS?: string;
};

export type SessionUser = { sub: string; email: string; name?: string };

const SESSION_COOKIE = "tasks_session";
const OAUTH_COOKIE = "tasks_oauth";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const encoder = new TextEncoder();

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let raw = "";
  for (const byte of view) raw += String.fromCharCode(byte);
  return btoa(raw).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64url(await crypto.subtle.sign("HMAC", key, encoder.encode(data)));
}

/** value = base64url(json) + "." + hmac — verified and expiry-checked on open. */
async function seal(secret: string, payload: Record<string, unknown>, ttlSeconds: number) {
  const body = base64url(encoder.encode(JSON.stringify({ ...payload, exp: Date.now() + ttlSeconds * 1000 })));
  return `${body}.${await hmac(secret, body)}`;
}

async function open(secret: string, sealed: string | undefined): Promise<Record<string, unknown> | null> {
  if (!sealed) return null;
  const [body, mac] = sealed.split(".");
  if (!body || !mac) return null;
  if ((await hmac(secret, body)) !== mac) return null;
  try {
    const padded = body.replaceAll("-", "+").replaceAll("_", "/");
    const json = JSON.parse(atob(padded)) as Record<string, unknown> & { exp?: number };
    if (typeof json.exp !== "number" || json.exp < Date.now()) return null;
    return json;
  } catch {
    return null;
  }
}

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

function cookieHeader(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

function sessionSecret(env: AppEnv): string {
  if (!env.SESSION_SECRET) throw new Error("SESSION_SECRET is not configured");
  return env.SESSION_SECRET;
}

export async function sessionFromRequest(env: AppEnv, request: Request): Promise<SessionUser | null> {
  if (env.DEV_ALLOW_ANONYMOUS === "1") {
    return { sub: "dev", email: "dev@localhost", name: "Local Dev" };
  }
  const payload = await open(sessionSecret(env), readCookie(request, SESSION_COOKIE));
  if (!payload || typeof payload.sub !== "string" || typeof payload.email !== "string") return null;
  return { sub: payload.sub, email: payload.email, name: typeof payload.name === "string" ? payload.name : undefined };
}

/** /auth/login: stash state+PKCE verifier+next in a short-lived cookie, bounce to authorize. */
export async function startLogin(env: AppEnv, request: Request): Promise<Response> {
  const next = new URL(request.url).searchParams.get("next") ?? "/";
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(await crypto.subtle.digest("SHA-256", encoder.encode(verifier)));

  const authorize = new URL(`${env.AUTH_ISSUER}/oauth2/authorize`);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", env.AUTH_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", `${env.PUBLIC_BASE_URL}/auth/callback`);
  authorize.searchParams.set("scope", "openid profile email");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");

  return new Response(null, {
    status: 302,
    headers: {
      location: authorize.toString(),
      "set-cookie": cookieHeader(
        OAUTH_COOKIE,
        await seal(sessionSecret(env), { state, verifier, next: next.startsWith("/") ? next : "/" }, 600),
        600,
      ),
    },
  });
}

/** /auth/callback: code → tokens (client_secret_basic + PKCE) → userinfo → session cookie. */
export async function finishLogin(env: AppEnv, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const stash = await open(sessionSecret(env), readCookie(request, OAUTH_COOKIE));
  if (!code || !state || !stash || stash.state !== state || typeof stash.verifier !== "string") {
    return new Response("login flow expired or tampered with — try again from /auth/login", { status: 400 });
  }

  const tokenResponse = await fetch(`${env.AUTH_ISSUER}/oauth2/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${btoa(`${env.AUTH_CLIENT_ID}:${env.AUTH_CLIENT_SECRET ?? ""}`)}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${env.PUBLIC_BASE_URL}/auth/callback`,
      code_verifier: stash.verifier,
    }),
  });
  if (!tokenResponse.ok) {
    return new Response(`token exchange failed: ${tokenResponse.status} ${await tokenResponse.text()}`, {
      status: 502,
    });
  }
  const tokens = (await tokenResponse.json()) as { access_token?: string };
  if (!tokens.access_token) return new Response("token exchange returned no access_token", { status: 502 });

  const userinfoResponse = await fetch(`${env.AUTH_ISSUER}/oauth2/userinfo`, {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  });
  if (!userinfoResponse.ok) {
    return new Response(`userinfo failed: ${userinfoResponse.status}`, { status: 502 });
  }
  const userinfo = (await userinfoResponse.json()) as { sub?: string; email?: string; name?: string };
  if (!userinfo.sub || !userinfo.email) {
    return new Response("userinfo missing sub/email", { status: 502 });
  }

  const next = typeof stash.next === "string" && stash.next.startsWith("/") ? stash.next : "/";
  return new Response(null, {
    status: 302,
    headers: [
      ["location", next],
      [
        "set-cookie",
        cookieHeader(
          SESSION_COOKIE,
          await seal(
            sessionSecret(env),
            { sub: userinfo.sub, email: userinfo.email, name: userinfo.name },
            SESSION_TTL_SECONDS,
          ),
          SESSION_TTL_SECONDS,
        ),
      ],
      ["set-cookie", cookieHeader(OAUTH_COOKIE, "", 0)],
    ],
  });
}

export function logout(): Response {
  return new Response(null, {
    status: 302,
    headers: { location: "/", "set-cookie": cookieHeader(SESSION_COOKIE, "", 0) },
  });
}
