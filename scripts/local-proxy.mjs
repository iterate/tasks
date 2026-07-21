// Local stand-in for the config-worker proxy: forwards http://localhost:<port>
// to the tasks vite dev server, stamping the trusted project header + auth
// cookie the vessel expects (prod: the project's config worker does this).
// Handles WebSocket upgrades (both /yjs and /api lanes need them).
// Usage: node scripts/local-proxy.mjs <listenPort> <targetPort> <projectId> <token>
import http from "node:http";
import net from "node:net";

const [listenPort, targetPort, projectId, token] = process.argv.slice(2);
if (!listenPort || !targetPort || !projectId || !token) {
  console.error("usage: local-proxy.mjs <listenPort> <targetPort> <projectId> <token>");
  process.exit(1);
}

const stamp = (headers) => {
  const out = { ...headers, "x-itx-project-id": projectId };
  const cookies = [headers.cookie, `iterate-project-auth=${token}`].filter(Boolean);
  out.cookie = cookies.join("; ");
  return out;
};

const server = http.createServer((req, res) => {
  const proxied = http.request(
    { host: "localhost", port: Number(targetPort), path: req.url, method: req.method, headers: stamp(req.headers) },
    (upstream) => {
      res.writeHead(upstream.statusCode ?? 502, upstream.headers);
      upstream.pipe(res);
    },
  );
  proxied.on("error", () => res.writeHead(502).end("proxy error"));
  req.pipe(proxied);
});

server.on("upgrade", (req, socket, head) => {
  const upstream = net.connect(Number(targetPort), "localhost", () => {
    const headers = stamp(req.headers);
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [key, value] of Object.entries(headers)) {
      for (const one of Array.isArray(value) ? value : [value]) lines.push(`${key}: ${one}`);
    }
    upstream.write(lines.join("\r\n") + "\r\n\r\n");
    if (head?.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  const drop = () => { socket.destroy(); upstream.destroy(); };
  upstream.on("error", drop);
  socket.on("error", drop);
});

server.listen(Number(listenPort), "127.0.0.1", () => {
  console.log(`board: http://localhost:${listenPort}  →  vessel :${targetPort}  (project ${projectId})`);
});
