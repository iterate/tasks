// Dev/ops probe: mint a valid tasks-app session cookie from a known
// SESSION_SECRET — the app's own trust boundary, for headless testing of a
// deployment you operate. Usage:
//   SESSION_SECRET=... node scripts/mint-session-cookie.mjs [email]
const secret = process.env.SESSION_SECRET;
if (!secret) throw new Error("SESSION_SECRET required");
const email = process.argv[2] ?? "probe@iterate.com";

const encoder = new TextEncoder();
const base64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const key = await crypto.subtle.importKey(
  "raw",
  encoder.encode(secret),
  { name: "HMAC", hash: "SHA-256" },
  false,
  ["sign"],
);
const body = base64url(
  encoder.encode(
    JSON.stringify({ sub: "probe", email, name: "Headless Probe", exp: Date.now() + 3600_000 }),
  ),
);
const mac = base64url(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
console.log(`tasks_session=${body}.${mac}`);
