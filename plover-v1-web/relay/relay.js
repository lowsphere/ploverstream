"use strict";
// Pairing WebSocket relay for the pixel-streaming browser, built to run on AWS
// Elastic Beanstalk (Node.js platform, behind its nginx proxy + load balancer).
//
// The origin (server.js) runs on a home machine with no port forwarding, so the
// relay cannot dial into it. Instead the home machine runs agent.js, which dials
// OUT to this relay and registers. The relay then pairs each incoming portable
// client to a fresh connection the agent opens back, and forwards the pixel
// stream between them byte-for-byte. The pixel protocol -- including PIXEL_TOKEN
// in the client's first "auth" message -- stays end-to-end between the client
// and server.js; the relay never inspects or needs it.
//
//   portable client --wss--> [ EB nginx :8080 ] --> relay
//   agent (home PC) --wss--> relay   (control channel, stays open)
//   per session: relay tells the agent a sid; the agent opens a data connection
//   back (--wss-->) carrying that sid, and the relay splices it to the client.
//
// A shared AGENT_SECRET authenticates the agent to the relay so no one else can
// register as the origin or claim a pending session. This relay keeps per-client
// state on one instance, so run it as a SINGLE instance (eb scale 1).
//
// Environment
//   PORT              8080   port EB's nginx proxies to (Beanstalk sets this)
//   AGENT_SECRET      required  shared secret; must match agent.js
//   ALLOWED_ORIGINS   comma-separated browser Origins allowed for clients.
//                     A file:// portable copy sends Origin "null" (always ok).
//                     Unset => all origins allowed (server.js's token still gates).
//   MAX_CLIENTS       256    concurrent client sockets
//   PAIR_TIMEOUT_MS   12000  how long a client waits for the agent to connect back

const crypto = require("crypto");
const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT) || 8080;
const AGENT_SECRET = process.env.AGENT_SECRET || "";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
const MAX_CLIENTS = Math.max(1, Number(process.env.MAX_CLIENTS) || 256);
const PAIR_TIMEOUT_MS = Math.max(2000, Number(process.env.PAIR_TIMEOUT_MS) || 12000);
const MAX_PAYLOAD = 4 << 20;

const log = (msg) => console.log(new Date().toISOString().slice(11, 23) + " " + msg);
const noop = () => {};

if (!AGENT_SECRET) {
  log("fatal: set AGENT_SECRET (must match agent.js)");
  process.exit(1);
}
function secretOk(got) {
  const a = Buffer.from(String(got || "")), b = Buffer.from(AGENT_SECRET);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// A 0x00 control frame carrying pixel-protocol JSON, so client.html can
// surface relay-side problems through its normal error path.
function controlFrame(obj) {
  return Buffer.concat([Buffer.from([0x00]), Buffer.from(JSON.stringify(obj))]);
}

// Beanstalk's load balancer health-checks "/" over plain HTTP and expects 2xx;
// WebSocket upgrades arrive on the same port and are handled below.
const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/health" || req.url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
    res.end("ok agent=" + (agentControl ? "up" : "down") + "\n");
    return;
  }
  res.writeHead(426, { "content-type": "text/plain", upgrade: "websocket" }).end("WebSocket endpoint.\n");
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin || origin === "null") return true;
  if (ALLOWED_ORIGINS.length === 0) return true;
  return ALLOWED_ORIGINS.includes(origin);
}
function reject(socket, line) { try { socket.end("HTTP/1.1 " + line + "\r\nConnection: close\r\n\r\n"); } catch (_) {} }

let agentControl = null;            // the single registered agent's control socket
const pending = new Map();          // sid -> { client, queue, dataWs, timer }
let clients = 0;

server.on("upgrade", (req, socket, head) => {
  let pathname = "/";
  try { pathname = new URL(req.url, "http://x").pathname; } catch (_) {}

  if (pathname === "/__agent/control" || pathname === "/__agent/data") {
    if (!secretOk(req.headers["x-relay-secret"])) { reject(socket, "401 Unauthorized"); return; }
    wss.handleUpgrade(req, socket, head, (ws) =>
      pathname === "/__agent/control" ? onAgentControl(ws) : onAgentData(ws, req));
    return;
  }

  // Otherwise a portable client.
  if (!originAllowed(req)) { reject(socket, "403 Forbidden"); return; }
  if (clients >= MAX_CLIENTS) { reject(socket, "503 Service Unavailable"); return; }
  wss.handleUpgrade(req, socket, head, (ws) => onClient(ws, req));
});

// ----------------------------------------------------------------- agent side
function onAgentControl(ws) {
  if (agentControl) { try { agentControl.close(1000, "replaced"); } catch (_) {} }
  agentControl = ws;
  log("agent registered");
  ws.on("message", noop);           // control is relay->agent only for now
  ws.on("error", noop);
  ws.on("close", () => { if (agentControl === ws) { agentControl = null; log("agent gone"); } });
}

function onAgentData(ws, req) {
  const sid = String(req.headers["x-relay-sid"] || "");
  const entry = pending.get(sid);
  if (!entry) { try { ws.close(1008, "no such session"); } catch (_) {} return; }
  pending.delete(sid);
  clearTimeout(entry.timer);
  entry.dataWs = ws;
  splice(entry.client, ws, entry.queue);
}

// ---------------------------------------------------------------- client side
function onClient(client, req) {
  clients++;
  const ip = (String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) ||
             String(req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  client.on("error", noop);
  client.once("close", () => { clients--; });

  if (!agentControl) {
    try { if (client.readyState === 1) client.send(controlFrame({ t: "err", code: "relay_origin_unreachable", msg: "The browser server is not connected to the relay." })); } catch (_) {}
    try { client.close(1013, "origin offline"); } catch (_) {}
    return;
  }

  const sid = crypto.randomUUID();
  const entry = { client, queue: [], dataWs: null, timer: null };
  pending.set(sid, entry);
  log("client " + ip + " (" + clients + ") -> session " + sid.slice(0, 8));

  // Buffer client->origin messages until the agent's data connection is spliced.
  client.on("message", (data, isBinary) => {
    if (entry.dataWs) send(entry.dataWs, data, isBinary);
    else entry.queue.push([data, isBinary]);
  });
  client.on("close", () => {
    if (pending.get(sid) === entry) pending.delete(sid);
    clearTimeout(entry.timer);
  });

  entry.timer = setTimeout(() => {
    if (pending.get(sid) !== entry) return;
    pending.delete(sid);
    try { if (client.readyState === 1) client.send(controlFrame({ t: "err", code: "relay_pair_timeout", msg: "The browser server did not answer in time." })); } catch (_) {}
    try { client.close(1013, "pair timeout"); } catch (_) {}
  }, PAIR_TIMEOUT_MS);

  try { agentControl.send(JSON.stringify({ t: "open", sid })); }
  catch (e) { clearTimeout(entry.timer); pending.delete(sid); try { client.close(1011, "agent error"); } catch (_) {} }
}

// --------------------------------------------------------------------- bridge
function splice(client, dataWs, queue) {
  for (const [data, isBinary] of queue) send(dataWs, data, isBinary);
  queue.length = 0;

  dataWs.on("message", (data, isBinary) => send(client, data, isBinary));
  dataWs.on("error", noop);

  let closed = false;
  const stop = (code, reason) => {
    if (closed) return;
    closed = true;
    try { client.close(code, reason); } catch (_) {}
    try { dataWs.close(code, reason); } catch (_) {}
    setTimeout(() => { try { client.terminate(); } catch (_) {} try { dataWs.terminate(); } catch (_) {} }, 5000).unref();
  };
  const norm = (c) => (c === 1005 || c === 1006 ? 1000 : c);
  client.on("close", (c, r) => stop(norm(c), r));
  dataWs.on("close", (c, r) => stop(norm(c), r));
}

function send(ws, data, isBinary) {
  if (ws.readyState !== 1) return;
  try { ws.send(data, { binary: isBinary }); } catch (_) {}
}

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) { try { ws.ping(); } catch (_) {} }
}, 30000);
heartbeat.unref();

server.listen(PORT, () => {
  log("pairing relay on :" + PORT);
  log("client origins: " + (ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS.join(", ") + " (and null)" : "ALL (and null)"));
});

function shutdown() {
  log("shutting down");
  clearInterval(heartbeat);
  for (const ws of wss.clients) { try { ws.close(1001, "relay stopping"); } catch (_) {} }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
