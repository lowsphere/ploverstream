"use strict";
// Relay agent. Runs on the same machine as server.js (the home PC with no port
// forwarding). It dials OUT to the Elastic Beanstalk relay and registers, then
// for each session the relay announces it opens a fresh connection back to the
// relay and bridges it to the local server.js stream. Nothing listens for inbound
// connections here, so no port forwarding is needed.
//
//   agent.js --wss--> relay (control, stays open)
//   per session: relay -> {t:"open", sid}; agent opens a data connection back
//   (carrying sid) and a local ws to server.js, then forwards between them.
//
// The pixel token is NOT needed here: the client's "auth" flows through to
// server.js, which checks it end-to-end.
//
//   node agent.js                 (reads the env vars below)
//
// Environment
//   RELAY_URL      required  base URL of the relay, e.g. wss://relay.example.com
//                            (no path; agent appends /__agent/control and /data)
//   AGENT_SECRET   required  shared secret; must match the relay's AGENT_SECRET
//   LOCAL_ORIGIN   ws://127.0.0.1:8765   server.js's stream (PORT)
//   RELAY_TLS_INSECURE  "1" to skip TLS verification of a wss:// RELAY_URL

const { WebSocket } = require("ws");

const RELAY_URL = (process.env.RELAY_URL || "").trim().replace(/\/+$/, "");
const AGENT_SECRET = process.env.AGENT_SECRET || "";
const LOCAL_ORIGIN = (process.env.LOCAL_ORIGIN || "ws://127.0.0.1:8765").trim();
const RELAY_TLS_INSECURE = process.env.RELAY_TLS_INSECURE === "1";
const MAX_PAYLOAD = 4 << 20;

const log = (msg) => console.log(new Date().toISOString().slice(11, 23) + " " + msg);
const noop = () => {};

if (!RELAY_URL || !/^wss?:\/\//.test(RELAY_URL)) { log("fatal: set RELAY_URL=wss://your-relay-host"); process.exit(1); }
if (!AGENT_SECRET) { log("fatal: set AGENT_SECRET (must match the relay)"); process.exit(1); }

const controlUrl = RELAY_URL + "/__agent/control";
const dataUrl = RELAY_URL + "/__agent/data";
const wsOpts = { headers: { "x-relay-secret": AGENT_SECRET }, maxPayload: MAX_PAYLOAD, perMessageDeflate: false,
  rejectUnauthorized: !RELAY_TLS_INSECURE, handshakeTimeout: 15000 };

let backoff = 1000;
function connectControl() {
  const ws = new WebSocket(controlUrl, wsOpts);
  let alive = false;
  ws.on("open", () => { alive = true; backoff = 1000; log("registered with relay at " + RELAY_URL); });
  ws.on("message", (data) => {
    let m; try { m = JSON.parse(data.toString()); } catch (_) { return; }
    if (m && m.t === "open" && typeof m.sid === "string") startSession(m.sid);
  });
  ws.on("error", (e) => log("control error: " + e.message));
  ws.on("close", (code) => {
    const delay = alive ? 1000 : backoff;
    if (!alive) backoff = Math.min(backoff * 2, 30000);
    log("control closed (" + code + "); reconnecting in " + delay + "ms");
    setTimeout(connectControl, delay);
  });
  // Keep the NAT mapping and the socket alive.
  const ping = setInterval(() => { try { ws.ping(); } catch (_) {} }, 25000);
  ws.on("close", () => clearInterval(ping));
}

// One session: a data connection back to the relay, bridged to a fresh local
// connection to server.js. Messages are forwarded verbatim, binary type kept,
// and each side is buffered until both are open.
function startSession(sid) {
  const data = new WebSocket(dataUrl, { ...wsOpts, headers: { ...wsOpts.headers, "x-relay-sid": sid } });
  const local = new WebSocket(LOCAL_ORIGIN, { maxPayload: MAX_PAYLOAD, perMessageDeflate: false });
  bridge(data, local, sid);
}

function bridge(a, b, sid) {
  const qa = [], qb = [];                 // queued until the far side opens
  let closed = false;
  const stop = (code, reason) => {
    if (closed) return; closed = true;
    try { a.close(code, reason); } catch (_) {}
    try { b.close(code, reason); } catch (_) {}
    setTimeout(() => { try { a.terminate(); } catch (_) {} try { b.terminate(); } catch (_) {} }, 5000).unref();
  };
  const norm = (c) => (c === 1005 || c === 1006 ? 1000 : c);

  a.on("open", () => { for (const [d, bin] of qa) send(a, d, bin); qa.length = 0; });
  b.on("open", () => { for (const [d, bin] of qb) send(b, d, bin); qb.length = 0; });

  a.on("message", (d, bin) => { if (b.readyState === 1) send(b, d, bin); else qb.push([d, bin]); });
  b.on("message", (d, bin) => { if (a.readyState === 1) send(a, d, bin); else qa.push([d, bin]); });

  a.on("error", (e) => log("session " + sid.slice(0, 8) + " relay-side: " + e.message));
  b.on("error", (e) => log("session " + sid.slice(0, 8) + " local-side: " + e.message));
  a.on("close", (c, r) => stop(norm(c), r));
  b.on("close", (c, r) => stop(norm(c), r));
}

function send(ws, data, isBinary) {
  if (ws.readyState !== 1) return;
  try { ws.send(data, { binary: isBinary }); } catch (_) {}
}

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
connectControl();
