"use strict";
// Backend for client.html. A WebSocket on PORT speaks the
// pixel-streaming protocol described at the top of that file, driving a
// shared headless Chromium (one isolated browser context per session). The
// page itself is served on HTTP_PORT, for browsers that can't open the file.
//
//   npm install
//   npm start          then open client.html from disk, or the URL it prints
//
// Environment
//   PORT              8765  the stream (client.html's PIXEL_SERVER and CSP name it)
//   HTTP_PORT         8081  the page
//   HOST              127.0.0.1; set 0.0.0.0 to accept other machines (use TLS then)
//   PIXEL_TOKEN       access token; defaults to .pixel-token, created on first run
//   MAX_SESSIONS      4
//   SESSION_IDLE_MIN  5   minutes a session survives with no viewer attached
//   CHROME_PATH       Chrome/Chromium/Edge binary; found automatically if unset
//   TLS_CERT, TLS_KEY PEM files; serve https/wss instead of http/ws
//   ALLOWED_ORIGINS   comma-separated extra page origins that may open the stream
//   TERMINAL_PASS_HASH  turns on the Web OS Terminal: a shell on this machine for
//                     clients with the token AND the password this hash was made
//                     from (node lib/terminal.js prints one). Unset: no terminal.
//   PIXEL_DELAY_MS    0; testing only, adds this many ms of latency to every
//                     server->client message (frames and control). 0 disables.

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");
const { WebSocketServer } = require("ws");
const { Hub } = require("./lib/hub");
const { Session } = require("./lib/session");
const { Terminal, parseHash, verifyPassword } = require("./lib/terminal");

const PORT = Number(process.env.PORT) || 8765;
const HTTP_PORT = Number(process.env.HTTP_PORT) || 8081;
const HOST = process.env.HOST || "127.0.0.1";
const TOKEN_FILE = path.join(__dirname, ".pixel-token");
const TOKEN = process.env.PIXEL_TOKEN || loadToken();
const MAX_SESSIONS = Math.max(1, Number(process.env.MAX_SESSIONS) || 4);
const IDLE_MS = Math.max(0.1, Number(process.env.SESSION_IDLE_MIN) || 5) * 60000;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
const SEND_DELAY_MS = Math.max(0, Number(process.env.PIXEL_DELAY_MS) || 0);   // testing: artificial downstream latency
const TLS = process.env.TLS_CERT && process.env.TLS_KEY
  ? { cert: fs.readFileSync(process.env.TLS_CERT), key: fs.readFileSync(process.env.TLS_KEY) } : null;
const CLIENT_FILE = path.join(__dirname, "client.html");
const TERMINAL_HASH = parseHash(process.env.TERMINAL_PASS_HASH);
const MAX_TERMINALS = 4;

const noop = () => {};
const log = (msg) => console.log(new Date().toISOString().slice(11, 23) + " " + msg);

const hub = new Hub(log);
const sessions = new Map();
const terminals = new Set();
let creating = 0;

// Stable across restarts, so the copy of client.html on disk can carry
// it as PIXEL_TOKEN.
function loadToken() {
  try { const t = fs.readFileSync(TOKEN_FILE, "utf8").trim(); if (t) return t; } catch (_) {}
  const t = crypto.randomBytes(18).toString("base64url");
  fs.writeFileSync(TOKEN_FILE, t + "\n", { mode: 0o600 });
  return t;
}
const TOKEN_LINE = /const PIXEL_TOKEN = "([^"]*)";/;
const SERVER_LINE = /const PIXEL_SERVER = "([^"]*)";/;
const CONNECT_SRC = /connect-src [^;"]*/;

// ------------------------------------------------------------------- page
function hostnameOf(hostHeader) {
  try {
    const h = new URL("http://" + hostHeader).hostname;
    if (/^[a-z0-9.-]+$|^\[[0-9a-f:.]+\]$/i.test(h)) return h;
  } catch (_) {}
  return "127.0.0.1";
}

// The copy on disk names the stream it connects to and carries the token. A
// served copy instead points at the stream port on whatever host it was
// loaded from, and must not hand the token to whoever asks for the page:
// served viewers bring it in the #token link.
function servedPage(html, req) {
  const stream = (TLS ? "wss://" : "ws://") + hostnameOf(req.headers.host) + ":" + PORT;
  const out = html
    .replace(TOKEN_LINE, 'const PIXEL_TOKEN = "";')
    .replace(SERVER_LINE, 'const PIXEL_SERVER = "' + stream + '";')
    .replace(CONNECT_SRC, "connect-src " + stream);
  return out.includes(TOKEN) ? null : out;
}

function onPageRequest(req, res) {
  const { pathname } = new URL(req.url, "http://localhost");
  if (pathname !== "/" && pathname !== "/client.html") {
    res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { allow: "GET, HEAD" }).end(); return; }
  fs.readFile(CLIENT_FILE, "utf8", (err, html) => {
    const body = err ? null : servedPage(html, req);
    if (!body) {
      res.writeHead(500, { "content-type": "text/plain" })
        .end(err ? "client.html is missing" : "client.html's PIXEL_TOKEN line was not recognised, so it is not served");
      return;
    }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
      "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY",
    });
    res.end(req.method === "HEAD" ? undefined : body);
  });
}

// -------------------------------------------------------------- websocket
// The stream port takes a WebSocket on any path; plain requests get a pointer.
function onStreamRequest(req, res) {
  res.writeHead(426, { "content-type": "text/plain", upgrade: "websocket" })
    .end("This port carries the browser stream. Open client.html, or the page on port " + HTTP_PORT + ".\n");
}

const pageServer = TLS ? https.createServer(TLS, onPageRequest) : http.createServer(onPageRequest);
const streamServer = TLS ? https.createServer(TLS, onStreamRequest) : http.createServer(onStreamRequest);
const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });

// Browsers always send Origin on a WebSocket handshake. Refusing foreign ones
// stops other sites from driving the browser through a visitor's network.
// A page opened from disk sends "null", but so can any site (from a sandboxed
// iframe), so for those the token is the only thing keeping others out.
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin || origin === "null") return true;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  // The page as served on HTTP_PORT by this same host.
  try {
    const o = new URL(origin);
    const port = Number(o.port) || (o.protocol === "https:" ? 443 : 80);
    return o.hostname === hostnameOf(req.headers.host) && port === HTTP_PORT;
  } catch (_) { return false; }
}

streamServer.on("upgrade", (req, socket, head) => {
  if (!originAllowed(req)) {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => onSocket(ws, req));
});

function normalizeIp(ip) { return String(ip || "").replace(/^::ffff:/, ""); }
function isLan(ip) {
  return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(ip) || ip === "::1" || /^f[cde]/i.test(ip);
}

class Conn {
  constructor(ws, ip) {
    this.ws = ws; this.ip = ip; this.transport = isLan(ip) ? "lan" : "wan";
    this.session = null; this.term = null; this.client = {}; this.authed = false; this.authing = false; this.busy = false;
  }
  open() { return this.ws.readyState === 1; }
  send(obj) { if (this.open()) this._emit(Buffer.concat([Buffer.from([0x00]), Buffer.from(JSON.stringify(obj))])); }
  sendRaw(buf) { if (this.open()) this._emit(buf); }
  // One send path so PIXEL_DELAY_MS adds latency uniformly. Equal delays keep
  // FIFO order; after waiting, the socket may have closed, so re-check.
  _emit(buf) {
    if (SEND_DELAY_MS) setTimeout(() => { if (this.open()) this.ws.send(buf); }, SEND_DELAY_MS);
    else this.ws.send(buf);
  }
  buffered() { return this.ws.bufferedAmount; }
  close(code, reason) { try { this.ws.close(code, reason); } catch (_) {} }
}

function parse(data, isBinary) {
  const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
  if (!isBinary) return JSON.parse(buf.toString("utf8"));
  if (buf.length === 0 || buf[0] !== 0x00) return null;
  return JSON.parse(buf.subarray(1).toString("utf8"));
}

function onSocket(ws, req) {
  const conn = new Conn(ws, normalizeIp(req.socket.remoteAddress));
  if (limited(conn.ip)) { conn.close(4429, "rate limited"); return; }
  const authTimer = setTimeout(() => { if (!conn.authed) conn.close(4401, "auth timeout"); }, 10000);
  ws.alive = true;
  ws.on("pong", () => { ws.alive = true; });
  ws.on("error", noop);
  ws.on("close", () => {
    clearTimeout(authTimer);
    if (conn.session) conn.session.detach(conn);
    if (conn.term) conn.term.close();
  });
  ws.on("message", (data, isBinary) => {
    let m;
    try { m = parse(data, isBinary); } catch (_) { conn.close(1007, "bad message"); return; }
    if (!m || typeof m.t !== "string") return;
    if (!conn.authed) {
      if (conn.authing) return;
      conn.authing = true; clearTimeout(authTimer);
      onAuth(conn, m).catch((e) => failed(conn, e));
      return;
    }
    if (conn.term) conn.term.handle(m);
    else if (conn.status) onStatus(conn, m);
    else if (conn.session) conn.session.handle(m);
    else onManage(conn, m).catch((e) => failed(conn, e));
  });
}

function failed(conn, e) {
  log("error: " + (e && e.stack || e));
  conn.send({ t: "err", code: "server_error", msg: "Could not start a browser session." });
  conn.close(1011, "server error");
}

// ------------------------------------------------------------------- auth
const strikes = new Map();   // ip -> {n, reset}
function strike(ip) {
  const now = Date.now(), s = strikes.get(ip);
  if (!s || s.reset < now) strikes.set(ip, { n: 1, reset: now + 60000 }); else s.n++;
}
function limited(ip) {
  const s = strikes.get(ip);
  if (!s) return false;
  if (s.reset < Date.now()) { strikes.delete(ip); return false; }
  return s.n >= 10;
}
function tokenOk(t) {
  const a = Buffer.from(String(t || "")), b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function str(v, max) { return typeof v === "string" ? v.slice(0, max) : ""; }

async function onAuth(conn, m) {
  if (m.t !== "auth" || !tokenOk(m.token)) { strike(conn.ip); conn.close(4401, "unauthorized"); return; }
  if (m.proto !== 1) { conn.close(4401, "unsupported protocol"); return; }
  const c = m.client || {};
  conn.client = { id: str(c.id, 64), device: str(c.device, 120) || "Unknown device" };
  if (m.mode === "terminal") { await openTerminal(conn, m); return; }
  // The Web OS desktop's top bar: ping and memory only, never a session.
  if (m.mode === "status") { conn.authed = true; conn.status = true; conn.send({ t: "status.ready" }); return; }
  conn.authed = true;
  const existing = typeof m.session === "string" ? sessions.get(m.session) : null;
  if (existing && !existing.closed) { existing.attach(conn); return; }
  await admit(conn);
}

// Terminal sign-in: the token was right, now the password. Failures are
// counted for the whole server, not per address: behind a tunnel or relay
// every client arrives from 127.0.0.1.
const termFails = { n: 0, reset: 0 };
const TERM_MAX_FAILS = 5, TERM_LOCK_MS = 10 * 60000;

async function openTerminal(conn, m) {
  const refuse = (code, msg, close) => { conn.send({ t: "err", code, msg }); conn.close(close, code); };
  if (!TERMINAL_HASH) return refuse("terminal_off", "The terminal is turned off on this server. Its owner can turn it on by setting a terminal password in Plover Server.", 4404);
  const now = Date.now();
  if (termFails.reset < now) { termFails.n = 0; termFails.reset = now + TERM_LOCK_MS; }
  if (termFails.n >= TERM_MAX_FAILS) {
    const min = Math.ceil((termFails.reset - now) / 60000);
    return refuse("terminal_locked", "Too many wrong passwords. Try again in " + min + " minute" + (min === 1 ? "" : "s") + ".", 4429);
  }
  if (!(await verifyPassword(m.password, TERMINAL_HASH))) {
    termFails.n++;
    log("terminal: wrong password from " + conn.client.device + " @ " + conn.ip + " (" + termFails.n + "/" + TERM_MAX_FAILS + ")");
    await new Promise((r) => setTimeout(r, 800));
    return refuse("bad_password", "That password isn't right.", 4403);
  }
  if (terminals.size >= MAX_TERMINALS) return refuse("terminal_full", "This server already has " + MAX_TERMINALS + " terminals open. Close one and try again.", 4503);
  if (!conn.open()) return;
  conn.authed = true;
  const t = new Terminal(conn, {
    log,
    onClose: () => { terminals.delete(t); log("terminal closed for " + conn.client.device + " @ " + conn.ip); },
  });
  conn.term = t;
  terminals.add(t);
  log("terminal opened for " + conn.client.device + " @ " + conn.ip);
  t.start();
}

// Start a new session for conn, or show it the session manager when full.
async function admit(conn) {
  if (sessions.size + creating >= MAX_SESSIONS) { sendFull(conn); return; }
  creating++;
  const s = new Session(hub, {
    id: crypto.randomUUID(), idleMs: IDLE_MS, log,
    onClose: (s, why) => { if (sessions.get(s.id) === s) sessions.delete(s.id); log("session " + s.id.slice(0, 8) + " closed (" + why + ")"); },
  });
  try { await s.init(); }
  catch (e) { s.destroy("init failed"); throw e; }
  finally { creating--; }
  sessions.set(s.id, s);
  log("session " + s.id.slice(0, 8) + " started for " + conn.client.device + " @ " + conn.ip);
  s.attach(conn);
  if (sessions.size >= MAX_SESSIONS) conn.send({ t: "slots", used: sessions.size, max: MAX_SESSIONS });
}

function sendFull(conn) {
  conn.send({ t: "full", used: sessions.size, max: MAX_SESSIONS, sessions: [...sessions.values()].map((s) => s.summary()) });
}

// A status connection gets the server machine's memory with each pong.
function onStatus(conn, m) {
  if (m.t !== "ping") return;
  const total = os.totalmem(), free = os.freemem();
  conn.send({ t: "pong", ts: m.ts, mem: { total, used: total - free } });
}

// An authenticated connection without a session is looking at "server full".
async function onManage(conn, m) {
  if (m.t === "ping") conn.send({ t: "pong", ts: m.ts });
  else if (m.t === "sessions.list") sendFull(conn);
  else if (m.t === "session.disconnect" && !conn.busy) {
    conn.busy = true;
    try {
      const s = sessions.get(String(m.id));
      if (s) {
        if (s.conn) s.conn.send({ t: "err", code: "session_closed", msg: "This session was closed from another device." });
        await s.destroy("taken over", 4409);
      }
      if (conn.open()) await admit(conn);
    } finally { conn.busy = false; }
  }
}

// ------------------------------------------------------------- lifecycle
hub.onCrash = () => {
  for (const s of [...sessions.values()]) {
    if (s.conn) s.conn.send({ t: "err", code: "browser_crashed", msg: "The browser crashed; starting a new one." });
    s.destroy("browser crashed", 1011);
  }
};

// Drop sockets whose peer vanished without a close.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false; ws.ping();
  }
}, 30000);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  log("shutting down");
  clearInterval(heartbeat);
  for (const t of [...terminals]) t.close(1001, "server stopping");
  await Promise.all([...sessions.values()].map((s) => s.destroy("server stopping", 1001)));
  pageServer.close(); streamServer.close();
  await hub.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function listen(server, port, what) {
  return new Promise((resolve) => {
    server.once("error", (e) => {
      log("cannot listen on " + HOST + ":" + port + " for the " + what + ": " + (e.code === "EADDRINUSE" ? "port in use (is another server.js running?)" : e.message));
      process.exit(1);
    });
    server.listen(port, HOST, resolve);
  });
}

// Catch the usual reasons the copy on disk would fail to connect.
function checkClientFile() {
  let html = "";
  try { html = fs.readFileSync(CLIENT_FILE, "utf8"); } catch (_) { return; }
  const baked = (html.match(TOKEN_LINE) || [])[1];
  if (baked && baked !== TOKEN) log("warning: PIXEL_TOKEN in client.html does not match this server's token; it will be rejected");
  let target = null;
  try { target = new URL((html.match(SERVER_LINE) || [])[1]); } catch (_) { return; }
  if (Number(target.port || 80) !== PORT) log("warning: client.html connects to port " + (target.port || 80) + ", but the stream is on " + PORT);
  const loopback = (h) => h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
  if (!loopback(target.hostname) && loopback(HOST)) {
    log("note: client.html connects to " + target.hostname + ", but this server only accepts this machine; set HOST=0.0.0.0 if that is this machine");
  }
}

(async () => {
  await listen(streamServer, PORT, "stream");
  await listen(pageServer, HTTP_PORT, "page");
  const host = HOST === "0.0.0.0" || HOST === "::" ? "localhost" : HOST.includes(":") ? "[" + HOST + "]" : HOST;
  log("stream on " + (TLS ? "wss" : "ws") + "://" + host + ":" + PORT);
  log("open " + CLIENT_FILE + " from disk, or " + (TLS ? "https" : "http") + "://" + host + ":" + HTTP_PORT + "/#token=" + TOKEN);
  checkClientFile();
  if (process.env.TERMINAL_PASS_HASH && !TERMINAL_HASH) log("warning: TERMINAL_PASS_HASH is not a hash made by lib/terminal.js, so the terminal is off");
  else if (TERMINAL_HASH) log("terminal on: clients with the token and the terminal password get a shell on this machine");
  if (!TLS && !["127.0.0.1", "localhost", "::1"].includes(HOST)) {
    log("warning: without TLS on a non-loopback address the token and every frame cross the network unencrypted");
  }
  hub.getBrowser().catch((e) => log("browser: " + e.message));   // fail fast on a bad CHROME_PATH
})();
