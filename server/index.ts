/**
 * Four Ponq — Stage 2 networked-multiplayer SERVER entry.
 *
 * A plain node:http server that:
 *   1. Serves the static client bundle from ./dist (relative to process.cwd(),
 *      which is /app in the container) for every route EXCEPT /ws + /presence:
 *        - index.html             → Cache-Control "no-cache" (always revalidate)
 *        - /assets/*  (hashed)    → "public, max-age=31536000, immutable"
 *        - unknown non-asset path → SPA fallback to index.html
 *      with correct content-types for the file extensions the bundle ships.
 *   2. Serves GET /presence — the live PresenceInfo JSON (humans/bots/mode/
 *      joinable) the hub polls for its channel badge. Always no-cache.
 *   3. Attaches a `ws` WebSocketServer that accepts the HTTP upgrade ONLY at the
 *      path /ws (any other upgrade path is rejected/destroyed).
 *
 * Build: `npm run build:server` (tsc -p tsconfig.server.json → dist-server/,
 * which also writes dist-server/package.json {"type":"commonjs"} so Node runs
 * the CommonJS output even though the package is "type":"module").
 * Run:   `npm start` (node dist-server/server/index.js), or directly with
 *        `PORT=4399 node dist-server/server/index.js`.
 */

import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { URL } from "node:url";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";

import type { ClientMsg } from "../shared/protocol";
import { Room, type Connection } from "./room";

const PORT = Number(process.env.PORT) || 3000;
const HOST = "0.0.0.0";

/** Directory holding the built client SPA. cwd is /app in the container. */
const DIST_DIR = path.resolve(process.cwd(), "dist");
const INDEX_HTML = path.join(DIST_DIR, "index.html");

/** WebSocket upgrade path. Everything else is static-file territory. */
const WS_PATH = "/ws";

/** Hub presence endpoint (see PresenceInfo in shared/protocol.ts). */
const PRESENCE_PATH = "/presence";

// One shared room for v1. Declared up here so the HTTP handler below can serve
// its live presence snapshot.
const room = new Room();

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8"
};

function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------

/**
 * Resolve a request URL path to a file inside DIST_DIR, guarding against path
 * traversal (any resolved path escaping DIST_DIR is rejected). Returns null for
 * paths that escape the root so the caller can fall back to index.html.
 */
function resolveStatic(urlPath: string): string | null {
  // Decode + normalize; strip the leading slash so path.join stays inside DIST.
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const rel = decoded.replace(/^\/+/, "");
  const resolved = path.resolve(DIST_DIR, rel);
  if (resolved !== DIST_DIR && !resolved.startsWith(DIST_DIR + path.sep)) {
    return null; // traversal attempt
  }
  return resolved;
}

async function serveFile(
  res: ServerResponse,
  filePath: string,
  cacheControl: string
): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      return false;
    }
    res.writeHead(200, {
      "Content-Type": contentTypeFor(filePath),
      "Content-Length": stat.size,
      "Cache-Control": cacheControl
    });
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(filePath);
      stream.on("error", reject);
      stream.on("end", () => resolve());
      stream.pipe(res);
    });
    return true;
  } catch {
    return false;
  }
}

/** Serve index.html with no-cache so menu/overlay updates land immediately. */
async function serveIndex(res: ServerResponse): Promise<void> {
  const ok = await serveFile(res, INDEX_HTML, "no-cache");
  if (!ok) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("four-ponq: client bundle (dist/index.html) not found");
  }
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!req.url) {
    res.writeHead(400);
    res.end();
    return;
  }

  // Only GET/HEAD are meaningful for a static bundle.
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  const pathname = url.pathname;

  // Live room presence for the hub channel badge — always fresh, never cached.
  if (pathname === PRESENCE_PATH) {
    const body = JSON.stringify(room.presence());
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-cache"
    });
    res.end(req.method === "HEAD" ? undefined : body);
    return;
  }

  // Root → index.html (no-cache).
  if (pathname === "/" || pathname === "/index.html") {
    await serveIndex(res);
    return;
  }

  const filePath = resolveStatic(pathname);
  if (filePath) {
    const isAsset = pathname.startsWith("/assets/");
    const cacheControl = isAsset ? "public, max-age=31536000, immutable" : "no-cache";
    if (await serveFile(res, filePath, cacheControl)) {
      return;
    }
    // A missing hashed asset is a hard 404 (never SPA-fallback into a JS/CSS
    // path; that would return HTML with the wrong content-type).
    if (isAsset) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
  }

  // SPA fallback: unknown non-asset route → index.html.
  await serveIndex(res);
}

// ---------------------------------------------------------------------------
// HTTP + WebSocket wiring
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    // Never let a handler rejection take the process down.
    // eslint-disable-next-line no-console
    console.error("[four-ponq] request error:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    }
    res.end("internal server error");
  });
});

// `noServer: true` so we can authorize the upgrade path ourselves and reject
// any upgrade that is not exactly /ws.
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  let pathname = "/";
  try {
    pathname = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).pathname;
  } catch {
    socket.destroy();
    return;
  }

  if (pathname !== WS_PATH) {
    // Reject non-/ws upgrades cleanly.
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws: WebSocket) => {
  const clientId = randomUUID();
  let joined = false;

  const conn: Connection = {
    clientId,
    send(msg) {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    }
  };

  ws.on("message", (raw) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw.toString()) as ClientMsg;
    } catch {
      conn.send({ t: "error", code: "bad_json", message: "malformed message" });
      return;
    }
    if (!msg || typeof msg !== "object" || typeof (msg as { t?: unknown }).t !== "string") {
      conn.send({ t: "error", code: "bad_msg", message: "missing message type" });
      return;
    }

    switch (msg.t) {
      case "hello": {
        if (joined) {
          return; // ignore a second hello
        }
        joined = true;
        room.connect(conn, typeof msg.name === "string" ? msg.name : "");
        break;
      }
      case "input": {
        if (!joined) return;
        room.setInput(clientId, !!msg.ccw, !!msg.cw, !!msg.charge);
        break;
      }
      case "join": {
        if (!joined) return;
        room.requestSeat(clientId);
        break;
      }
      case "ready": {
        if (!joined) return;
        room.ready(clientId, !!msg.on);
        break;
      }
      case "start": {
        // Legacy alias for {t:"ready", on:true}.
        if (!joined) return;
        room.ready(clientId, true);
        break;
      }
      case "setBots": {
        if (!joined) return;
        room.setBots(!!msg.on);
        break;
      }
      default: {
        conn.send({ t: "error", code: "unknown_type", message: `unknown message type` });
      }
    }
  });

  const cleanup = () => {
    if (joined) {
      room.leave(clientId);
    }
  };
  ws.on("close", cleanup);
  ws.on("error", cleanup);
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`[four-ponq] server listening on http://${HOST}:${PORT} (ws path ${WS_PATH})`);
  // eslint-disable-next-line no-console
  console.log(`[four-ponq] serving static client from ${DIST_DIR}`);
});
