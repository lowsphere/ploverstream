"use strict";
// Plover Server: a desktop front end that keeps a list of server profiles,
// runs each one's server.js (plus cloudflared or the relay agent, depending on
// how it is reached), and writes a client.html with that server's
// address and token filled in, or a Web OS desktop with that client inside.
//
// Each running profile is up to three child processes:
//   server   server.js, always; bound to 127.0.0.1 unless the profile is "custom"
//   tunnel   cloudflared quick tunnel to the stream port   (mode "tunnel")
//   agent    agent.js dialling out to a pairing relay      (mode "relay")

const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require("electron");
const { fork, spawn, execFile } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const path = require("path");

if (process.env.PLOVER_DATA_DIR) app.setPath("userData", path.resolve(process.env.PLOVER_DATA_DIR));

const SERVER_DIR = app.isPackaged ? path.join(process.resourcesPath, "server") : path.join(__dirname, "server");
const MODULES = path.join(__dirname, "node_modules");   // server.js's puppeteer-core and ws
const RUNNER = path.join(__dirname, "runner", "launch.js").replace("app.asar" + path.sep, "app.asar.unpacked" + path.sep);
const WEBOS_TEMPLATE = path.join(__dirname, "webos", "webos.html");
const DATA_DIR = app.getPath("userData");
const STORE_FILE = path.join(DATA_DIR, "servers.json");
const BIN_DIR = path.join(DATA_DIR, "bin");
const EXE = process.platform === "win32" ? ".exe" : "";
const MAX_LOG = 3000;

const TOKEN_LINE = /const PIXEL_TOKEN = "[^"]*";/;
const SERVER_LINE = /const PIXEL_SERVER = "[^"]*";/;
const CONNECT_SRC = /connect-src [^;"]*/;
const TUNNEL_URL = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/i;

// A terminal password is kept only as this scrypt hash (see lib/terminal.js).
const PASS_HASH = /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9_-]{16,}\$[A-Za-z0-9_-]{32,}$/;
const SCRYPT = { N: 16384, r: 8, p: 1 };

const WALLPAPER = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/;
const MAX_WALLPAPER = 8 * 1024 * 1024;

// Apps installed into the Web OS: single HTML files, built into the client
// file. The renderer turns an app's own icon into a small PNG.
const APP_ID = /^[a-z0-9]{6,32}$/;
const APP_ICON = /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/;
const MAX_APP = 5 * 1024 * 1024;
const MAX_APPS = 12;
const MAX_APPS_TOTAL = 24 * 1024 * 1024;

// Looks for the Web OS client (webos/webos.html styles each one under
// html[data-style]). The first accent is the style's default.
const OS_STYLES = {
  glassmorphic: { name: "Glassmorphic", accents: ["#3d6b26", "#1f5f8b", "#6b3fa0", "#a34a2a"] },
  neumorphic: { name: "Neumorphic", accents: ["#4f7a3a", "#3d6b8f", "#a0522d", "#5b4f8f"] },
  brutalist: { name: "Brutalist", accents: ["#ffe500", "#ff4d2e", "#3d5afe", "#00e676"] },
  sleek: { name: "Sleek", accents: ["#c6f36b", "#7dd3fc", "#f5f5f5", "#fb923c"] },
};

let win = null;

// ------------------------------------------------------------------ store
// Loaded below normalize() and its helpers: they are consts, and calling them
// before their definitions throws.

// A file that exists but cannot be read is copied aside first, so the next
// save does not overwrite the only copy of the user's servers.
function loadStore() {
  let raw;
  try { raw = fs.readFileSync(STORE_FILE, "utf8"); } catch (_) { return { servers: [] }; }
  try {
    const s = JSON.parse(raw);
    if (Array.isArray(s.servers)) { s.servers = s.servers.map(normalize); return s; }
    throw new Error("no server list");
  } catch (e) {
    const backup = STORE_FILE + ".unreadable-" + Date.now();
    try { fs.copyFileSync(STORE_FILE, backup); } catch (_) {}
    console.error("Could not load " + STORE_FILE + " (" + e.message + "); kept a copy at " + backup);
    return { servers: [] };
  }
}

function saveStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = STORE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STORE_FILE);
}

const randomToken = () => crypto.randomBytes(18).toString("base64url");
const find = (id) => store.servers.find((s) => s.id === id);

function int(v, def, min, max) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= min && n <= max ? n : def;
}
const text = (v, max = 500) => (typeof v === "string" ? v.trim().slice(0, max) : "");

// Fills in defaults and drops anything unexpected, for both stored and
// renderer-supplied profiles.
function normalize(p = {}) {
  const n = p.network || {}, r = n.relay || {}, c = n.custom || {}, w = p.webos || {}, t = p.terminal || {};
  const streamPort = int(n.streamPort, 8765, 1, 65535);
  const style = Object.hasOwn(OS_STYLES, w.style) ? w.style : "glassmorphic";
  return {
    id: typeof p.id === "string" && p.id ? p.id : crypto.randomUUID(),
    name: text(p.name, 80) || "Plover server",
    token: typeof p.token === "string" && /^[A-Za-z0-9_-]{16,}$/.test(p.token) ? p.token : randomToken(),
    createdAt: p.createdAt || new Date().toISOString(),
    kind: p.kind === "webos" ? "webos" : "standard",
    webos: {
      style,
      accent: typeof w.accent === "string" && /^#[0-9a-f]{6}$/i.test(w.accent) ? w.accent.toLowerCase() : OS_STYLES[style].accents[0],
      // A picture the desktop starts with, as a data URL (the renderer shrinks it to a JPEG).
      wallpaper: typeof w.wallpaper === "string" && w.wallpaper.length <= MAX_WALLPAPER && WALLPAPER.test(w.wallpaper) ? w.wallpaper : "",
      apps: normalizeApps(w.apps),
    },
    // The Web OS Terminal: on when a password is set (and the client is Web OS).
    terminal: { hash: typeof t.hash === "string" && PASS_HASH.test(t.hash) ? t.hash : "" },
    maxSessions: int(p.maxSessions, 4, 1, 64),
    idleMin: int(p.idleMin, 5, 1, 1440),
    chromePath: text(p.chromePath, 1000),
    autoStart: !!p.autoStart,
    network: {
      mode: ["tunnel", "relay", "custom"].includes(n.mode) ? n.mode : "tunnel",
      streamPort,
      pagePort: int(n.pagePort, 8081, 1, 65535),
      relay: { url: text(r.url).replace(/\/+$/, ""), secret: text(r.secret, 200), insecure: !!r.insecure },
      custom: {
        bindHost: text(c.bindHost, 100) || "0.0.0.0",
        publicHost: text(c.publicHost, 255).replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, ""),
        publicPort: int(c.publicPort, streamPort, 1, 65535),
        tls: !!c.tls,
        certPath: text(c.certPath, 1000),
        keyPath: text(c.keyPath, 1000),
      },
    },
  };
}

// The id names the app's saved data in the desktop, so it is kept as given.
function normalizeApps(list) {
  const out = [], seen = new Set();
  let total = 0;
  for (const a of Array.isArray(list) ? list : []) {
    if (!a || typeof a.html !== "string" || !a.html.trim() || a.html.length > MAX_APP) continue;
    if (out.length >= MAX_APPS || total + a.html.length > MAX_APPS_TOTAL) break;
    const id = typeof a.id === "string" && APP_ID.test(a.id) && !seen.has(a.id) ? a.id : crypto.randomBytes(6).toString("hex");
    seen.add(id); total += a.html.length;
    out.push({
      id,
      name: text(a.name, 40) || "App",
      icon: typeof a.icon === "string" && a.icon.length <= 200000 && APP_ICON.test(a.icon) ? a.icon : "",
      html: a.html,
    });
  }
  return out;
}

let store = loadStore();

// Ports not used by any other profile, for a new one.
function freePorts() {
  const used = new Set(store.servers.flatMap((s) => [s.network.streamPort, s.network.pagePort]));
  let stream = 8765, page = 8081;
  while (used.has(stream)) stream += 2;
  while (used.has(page) || page === stream) page += 1;
  return { stream, page };
}

function validate(p) {
  const errs = [], n = p.network;
  if (n.streamPort === n.pagePort) errs.push("The stream port and the page port must differ.");
  for (const o of store.servers) {
    if (o.id === p.id) continue;
    const clash = [n.streamPort, n.pagePort].filter((x) => x === o.network.streamPort || x === o.network.pagePort);
    if (clash.length) errs.push("Port " + clash[0] + " is already used by \u201c" + o.name + "\u201d.");
  }
  if (n.mode === "relay") {
    if (!/^wss?:\/\/[^/\s]+$/i.test(n.relay.url)) errs.push("Enter the relay address as wss://host (or ws://host), with no path.");
    if (!n.relay.secret) errs.push("Enter the relay's agent secret.");
  }
  if (n.mode === "custom") {
    const c = n.custom;
    if (!c.publicHost) errs.push("Enter the address clients connect to (an IP or domain name).");
    else if (!/^[a-z0-9.-]+$|^\[[0-9a-f:.]+\]$/i.test(c.publicHost)) errs.push("The client address should be a hostname or IP, e.g. 203.0.113.7 or plover.example.com (IPv6 in [brackets]).");
    if (!c.bindHost || net.isIP(c.bindHost) === 0 && c.bindHost !== "localhost") errs.push("The listen address must be an IP such as 0.0.0.0 (all interfaces) or 127.0.0.1.");
    if (c.tls && (!c.certPath || !c.keyPath)) errs.push("TLS needs both a certificate and a key file.");
  }
  return errs;
}

// The address a client connects to, or null while it is not known yet (a
// quick tunnel's address only exists once the tunnel is up).
function clientUrl(p) {
  const n = p.network;
  if (n.mode === "relay") return n.relay.url || null;
  if (n.mode === "custom") {
    if (!n.custom.publicHost) return null;
    return (n.custom.tls ? "wss://" : "ws://") + n.custom.publicHost + ":" + n.custom.publicPort;
  }
  const r = runs.get(p.id);
  return r && r.tunnelUrl ? r.tunnelUrl : null;
}

// ---------------------------------------------------------------- runtime
const runs = new Map();   // id -> { status, message, procs, tunnelUrl, agentUp, logs, stopping }

function run(id) {
  let r = runs.get(id);
  if (!r) { r = { status: "stopped", message: "", procs: {}, tunnelUrl: null, agentUp: false, logs: [], stopping: false }; runs.set(id, r); }
  return r;
}

function snapshot(id) {
  const r = run(id), p = find(id);
  return {
    id, status: r.status, message: r.message, agentUp: r.agentUp,
    clientUrl: p ? clientUrl(p) : null,
    procs: Object.fromEntries(Object.entries(r.procs).map(([k, v]) => [k, !!v])),
  };
}

function send(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }
const emit = (id) => send("runtime", snapshot(id));

function setStatus(id, status, message = "") {
  const r = run(id);
  r.status = status; r.message = message;
  emit(id);
}

function log(id, src, line) {
  const r = run(id);
  const entry = { t: Date.now(), src, line };
  r.logs.push(entry);
  if (r.logs.length > MAX_LOG) r.logs.splice(0, r.logs.length - MAX_LOG);
  send("log", { id, entry });
}

// Lines from a child's stdout/stderr, handed to onLine as they complete.
function lines(stream, onLine) {
  let buf = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      if (l.trim()) onLine(l);
    }
  });
}

function nodeChild(id, name, script, env) {
  const child = fork(RUNNER, [path.join(SERVER_DIR, script)], {
    cwd: SERVER_DIR, silent: true, windowsHide: true,
    env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: "1", NODE_PATH: MODULES },
  });
  return track(id, name, child);
}

// server.js checks the client.html next to it, but the app's copy is
// only a template (every handed-out file is generated per profile), so its
// warnings about that copy would just mislead.
const TEMPLATE_NOISE = /client\.html (connects to|does not match)|PIXEL_TOKEN in client\.html/;

function track(id, name, child) {
  const r = run(id);
  r.procs[name] = child;
  const onLine = (l) => {
    if (name === "server" && TEMPLATE_NOISE.test(l)) return;
    log(id, name, l); child.emit("line", l);
  };
  lines(child.stdout, onLine);
  lines(child.stderr, onLine);
  child.on("error", (e) => log(id, name, "could not start: " + e.message));
  child.on("exit", (code, signal) => {
    if (r.procs[name] === child) r.procs[name] = null;
    log(id, name, "exited (" + (signal || code) + ")");
    if (!r.stopping && r.status !== "stopped") {
      stopAll(id, "error", name === "server"
        ? "The server stopped unexpectedly. See Logs."
        : (name === "tunnel" ? "The Cloudflare tunnel" : "The relay agent") + " stopped unexpectedly. See Logs.");
    }
    emit(id);
  });
  return child;
}

// Resolves when the child prints a line matching re; rejects if it exits first.
function waitFor(child, re, ms) {
  return new Promise((resolve, reject) => {
    const done = (fn, v) => { clearTimeout(timer); child.off("line", onLine); child.off("exit", onExit); fn(v); };
    const onLine = (l) => { const m = l.match(re); if (m) done(resolve, m); };
    const onExit = () => done(reject, new Error("exited"));
    const timer = setTimeout(() => done(reject, new Error("timed out")), ms);
    child.on("line", onLine);
    child.on("exit", onExit);
  });
}

function portFree(port, host) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(port, host, () => s.close(() => resolve(true)));
  });
}

async function start(id) {
  const p = find(id);
  if (!p) throw new Error("No such server.");
  const r = run(id);
  if (r.status === "starting" || r.status === "running") return snapshot(id);
  const errs = validate(p);
  if (errs.length) throw new Error(errs.join(" "));

  const n = p.network;
  const custom = n.mode === "custom";
  const host = custom ? n.custom.bindHost : "127.0.0.1";
  r.stopping = false; r.tunnelUrl = null; r.agentUp = false;
  setStatus(id, "starting", "Starting the server\u2026");

  for (const port of [n.streamPort, n.pagePort]) {
    if (!(await portFree(port, host))) {
      setStatus(id, "error", "Port " + port + " is already in use on " + host + ". Pick another port under Networking.");
      return snapshot(id);
    }
  }
  if (custom && n.custom.tls) {
    for (const f of [n.custom.certPath, n.custom.keyPath]) {
      if (!fs.existsSync(f)) { setStatus(id, "error", "TLS file not found: " + f); return snapshot(id); }
    }
  }
  let cloudflared = null;
  if (n.mode === "tunnel") {
    cloudflared = await findCloudflared();
    if (!cloudflared) { setStatus(id, "error", "cloudflared is not installed. Install it from the Networking tab."); return snapshot(id); }
  }

  const env = {
    PORT: String(n.streamPort), HTTP_PORT: String(n.pagePort), HOST: host,
    PIXEL_TOKEN: p.token, MAX_SESSIONS: String(p.maxSessions), SESSION_IDLE_MIN: String(p.idleMin),
    CHROME_PATH: p.chromePath || "", TLS_CERT: "", TLS_KEY: "", PIXEL_DELAY_MS: "",
    TERMINAL_PASS_HASH: p.kind === "webos" ? p.terminal.hash : "",
  };
  if (custom && n.custom.tls) { env.TLS_CERT = n.custom.certPath; env.TLS_KEY = n.custom.keyPath; }
  log(id, "app", "starting " + p.name + " (" + n.mode + ")");
  const server = nodeChild(id, "server", "server.js", env);
  try { await waitFor(server, /stream on /, 20000); }
  catch (_) {
    if (r.status === "starting") stopAll(id, "error", "The server did not start. See Logs.");
    return snapshot(id);
  }
  if (r.stopping) return snapshot(id);

  if (n.mode === "custom") {
    setStatus(id, "running", "");
    return snapshot(id);
  }

  if (n.mode === "tunnel") {
    setStatus(id, "starting", "Opening a Cloudflare quick tunnel\u2026");
    const tunnel = track(id, "tunnel", spawn(cloudflared,
      ["tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:" + n.streamPort], { windowsHide: true }));
    try {
      const m = await waitFor(tunnel, TUNNEL_URL, 45000);
      r.tunnelUrl = m[0].replace(/^https:/i, "wss:");
      await waitFor(tunnel, /Registered tunnel connection/i, 30000).catch(() => {});
      if (r.status === "starting") setStatus(id, "running", "");
    } catch (_) {
      if (r.status === "starting") stopAll(id, "error", "Cloudflare did not hand out a tunnel address. See Logs.");
    }
    return snapshot(id);
  }

  // relay
  setStatus(id, "starting", "Connecting to the relay\u2026");
  const agent = nodeChild(id, "agent", "agent.js", {
    RELAY_URL: n.relay.url, AGENT_SECRET: n.relay.secret,
    LOCAL_ORIGIN: "ws://127.0.0.1:" + n.streamPort, RELAY_TLS_INSECURE: n.relay.insecure ? "1" : "",
  });
  agent.on("line", (l) => {
    if (/registered with relay/.test(l)) { r.agentUp = true; if (r.status !== "stopped") setStatus(id, "running", ""); }
    else if (/control closed/.test(l) && r.agentUp) { r.agentUp = false; if (r.status === "running") setStatus(id, "running", "Lost the relay; reconnecting\u2026"); }
  });
  waitFor(agent, /registered with relay/, 20000).catch(() => {
    if (r.status === "starting") setStatus(id, "starting", "Still trying to reach the relay. Check its address and secret (see Logs).");
  });
  return snapshot(id);
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => {});
  else try { child.kill("SIGKILL"); } catch (_) {}
}

// Ask each child to stop, then force whatever is left after a few seconds.
function stopAll(id, status = "stopped", message = "") {
  const r = run(id);
  r.stopping = true; r.agentUp = false; r.tunnelUrl = null;
  const children = Object.values(r.procs).filter(Boolean);
  for (const c of children) {
    if (c.connected) { try { c.send("stop"); } catch (_) {} }
    else killTree(c);
  }
  const forced = setTimeout(() => children.forEach(killTree), 6000);
  setStatus(id, status, message);
  return Promise.all(children.map((c) => c.exitCode !== null ? null : new Promise((res) => c.once("exit", res))))
    .then(() => clearTimeout(forced));
}

const anyRunning = () => [...runs.values()].some((r) => Object.values(r.procs).some(Boolean));

// ------------------------------------------------------------ cloudflared
function onPath(cmd) {
  return new Promise((resolve) => {
    execFile(process.platform === "win32" ? "where" : "which", [cmd], { windowsHide: true }, (err, out) =>
      resolve(err ? null : String(out).split(/\r?\n/).map((s) => s.trim()).find(Boolean) || null));
  });
}

async function findCloudflared() {
  const local = path.join(BIN_DIR, "cloudflared" + EXE);
  const known = process.platform === "win32"
    ? [local, "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe", "C:\\Program Files\\cloudflared\\cloudflared.exe"]
    : [local, "/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared", "/usr/bin/cloudflared"];
  return known.find((f) => fs.existsSync(f)) || (await onPath("cloudflared"));
}

function cloudflaredAsset() {
  const a = process.arch;
  if (process.platform === "win32") return a === "ia32" ? "cloudflared-windows-386.exe" : "cloudflared-windows-amd64.exe";
  if (process.platform === "darwin") return a === "arm64" ? "cloudflared-darwin-arm64.tgz" : "cloudflared-darwin-amd64.tgz";
  return { arm64: "cloudflared-linux-arm64", arm: "cloudflared-linux-arm", ia32: "cloudflared-linux-386" }[a] || "cloudflared-linux-amd64";
}

async function installCloudflared() {
  const asset = cloudflaredAsset();
  const url = "https://github.com/cloudflare/cloudflared/releases/latest/download/" + asset;
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error("Download failed (HTTP " + res.status + ").");
  const total = Number(res.headers.get("content-length")) || 0;
  const tmp = path.join(BIN_DIR, asset + ".part");
  const out = fs.createWriteStream(tmp);
  let got = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.length;
    if (!out.write(value)) await new Promise((r) => out.once("drain", r));
    send("cloudflared-progress", { got, total });
  }
  await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
  const dest = path.join(BIN_DIR, "cloudflared" + EXE);
  if (asset.endsWith(".tgz")) {
    await new Promise((r, j) => execFile("tar", ["-xzf", tmp, "-C", BIN_DIR], (e) => (e ? j(e) : r())));
    fs.rmSync(tmp, { force: true });
  } else {
    fs.renameSync(tmp, dest);
  }
  fs.chmodSync(dest, 0o755);
  return dest;
}

// ------------------------------------------------------------ client file
function buildClientHtml(p, url) {
  const html = fs.readFileSync(path.join(SERVER_DIR, "client.html"), "utf8");
  if (!TOKEN_LINE.test(html) || !SERVER_LINE.test(html) || !CONNECT_SRC.test(html)) {
    throw new Error("The bundled client.html is not in the expected format.");
  }
  const origin = new URL(url);
  const connect = origin.protocol + "//" + origin.host;
  const client = html
    .replace(TOKEN_LINE, () => "const PIXEL_TOKEN = " + JSON.stringify(p.token) + ";")
    .replace(SERVER_LINE, () => "const PIXEL_SERVER = " + JSON.stringify(url) + ";")
    .replace(CONNECT_SRC, () => "connect-src " + connect);
  return p.kind === "webos" ? buildWebOsHtml(p, client, connect, url) : client;
}

// The Web OS desktop runs the client above, unchanged, as its Browser app (an
// iframe written from CLIENT_HTML). A srcdoc frame inherits this page's CSP on
// top of its own, so connect-src here must name the stream too. The Terminal
// app opens its own connection to the same stream with the same token (the
// client inside carries it anyway), plus the password its user types.
const OS_CONFIG = /\/\*__PLOVER_OS__\*\/null/;
const OS_CLIENT = /"__PLOVER_CLIENT__"/;
const OS_CONNECT = /connect-src __PLOVER_CONNECT__/;
// Written as JSON escapes inside the page's <script>: "<" so the embedded
// page's own </script> tags can't close it, and the two line separators.
const SCRIPT_UNSAFE = new RegExp("[<" + String.fromCharCode(0x2028, 0x2029) + "]", "g");

function buildWebOsHtml(p, client, connect, url) {
  const html = fs.readFileSync(WEBOS_TEMPLATE, "utf8");
  if (!OS_CONFIG.test(html) || !OS_CLIENT.test(html) || !OS_CONNECT.test(html)) {
    throw new Error("The bundled webos.html is not in the expected format.");
  }
  const literal = (v) => JSON.stringify(v).replace(SCRIPT_UNSAFE, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  const config = { id: p.id, name: p.name, style: p.webos.style, accent: p.webos.accent, wallpaper: p.webos.wallpaper, apps: p.webos.apps, styles: OS_STYLES, server: url, token: p.token };
  return html
    .replace(OS_CONNECT, () => "connect-src " + connect)
    .replace(OS_CONFIG, () => literal(config))
    .replace(OS_CLIENT, () => literal(client));
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "plover";

// ------------------------------------------------------------------- ipc
function handle(channel, fn) {
  ipcMain.handle(channel, async (e, ...args) => {
    if (!win || e.sender !== win.webContents) throw new Error("Not allowed.");
    return fn(...args);
  });
}

handle("list", () => ({
  servers: store.servers,
  runtime: Object.fromEntries(store.servers.map((s) => [s.id, snapshot(s.id)])),
  platform: process.platform,
  styles: OS_STYLES,
}));

handle("defaults", () => {
  const { stream, page } = freePorts();
  const p = normalize({ name: "Server " + (store.servers.length + 1), network: { streamPort: stream, pagePort: page } });
  p.network.custom.publicPort = stream;
  return p;
});

handle("create", (input) => {
  const p = normalize({ ...input, id: undefined, token: undefined, createdAt: undefined, terminal: undefined });
  const errs = validate(p);
  if (errs.length) return { ok: false, errors: errs };
  store.servers.push(p); saveStore();
  return { ok: true, server: p };
});

handle("update", (id, input) => {
  const i = store.servers.findIndex((s) => s.id === id);
  if (i < 0) return { ok: false, errors: ["No such server."] };
  const old = store.servers[i];
  const p = normalize({ ...input, id, token: old.token, createdAt: old.createdAt, terminal: old.terminal });
  const errs = validate(p);
  if (errs.length) return { ok: false, errors: errs };
  store.servers[i] = p; saveStore();
  emit(id);
  return { ok: true, server: p };
});

handle("remove", async (id) => {
  if (runs.has(id)) await stopAll(id);
  runs.delete(id);
  store.servers = store.servers.filter((s) => s.id !== id); saveStore();
  return true;
});

handle("regenerate-token", (id) => {
  const p = find(id);
  if (!p) return null;
  p.token = randomToken(); saveStore();
  return p.token;
});

// Sets the Web OS Terminal's password (only its hash is kept), or with no
// password turns the terminal off. A running server picks it up on restart.
handle("set-terminal-password", async (id, password) => {
  const p = find(id);
  if (!p) return { ok: false, errors: ["No such server."] };
  let hash = "";
  if (password != null && password !== "") {
    const pw = String(password);
    if (pw.length < 8) return { ok: false, errors: ["Use at least 8 characters."] };
    if (pw.length > 256) return { ok: false, errors: ["Use at most 256 characters."] };
    const salt = crypto.randomBytes(16);
    const key = await new Promise((res, rej) => crypto.scrypt(pw, salt, 32, SCRYPT, (e, k) => (e ? rej(e) : res(k))));
    hash = ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64url"), key.toString("base64url")].join("$");
  }
  p.terminal = { hash }; saveStore();
  return { ok: true, server: p };
});

handle("start", (id) => start(id).catch((e) => { setStatus(id, "error", e.message); return snapshot(id); }));
handle("stop", async (id) => { await stopAll(id); return snapshot(id); });
handle("restart", async (id) => { await stopAll(id); return start(id).catch((e) => { setStatus(id, "error", e.message); return snapshot(id); }); });
handle("logs", (id) => run(id).logs);
handle("clear-logs", (id) => { run(id).logs = []; return true; });

handle("download-html", async (id) => {
  const p = find(id);
  if (!p) throw new Error("No such server.");
  const url = clientUrl(p);
  if (!url) throw new Error(p.network.mode === "tunnel"
    ? "Start the server first: a quick tunnel's address is only known once it is up."
    : "Finish the networking settings first.");
  const html = buildClientHtml(p, url);
  const res = await dialog.showSaveDialog(win, {
    title: "Save Plover client",
    defaultPath: path.join(app.getPath("downloads"), "plover-" + slug(p.name) + (p.kind === "webos" ? "-os" : "") + ".html"),
    filters: [{ name: "HTML file", extensions: ["html"] }],
  });
  if (res.canceled || !res.filePath) return null;
  fs.writeFileSync(res.filePath, html);
  shell.showItemInFolder(res.filePath);
  return res.filePath;
});

handle("export-relay", async () => {
  const res = await dialog.showOpenDialog(win, {
    title: "Choose where to put the relay files", properties: ["openDirectory", "createDirectory"],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  const dest = path.join(res.filePaths[0], "plover-relay");
  fs.cpSync(path.join(SERVER_DIR, "relay"), dest, { recursive: true });
  shell.openPath(dest);
  return dest;
});

handle("test-relay", async (url) => {
  const http = String(url || "").trim().replace(/^ws/i, "http").replace(/\/+$/, "") + "/health";
  try {
    const res = await fetch(http, { signal: AbortSignal.timeout(8000) });
    const body = (await res.text()).trim();
    if (!res.ok || !/^ok agent=/.test(body)) return { ok: false, msg: "Something answered at " + http + ", but it is not a Plover relay (HTTP " + res.status + ")." };
    return { ok: true, agentUp: /agent=up/.test(body), msg: body };
  } catch (e) {
    return { ok: false, msg: "Could not reach " + http + ": " + (e.cause && e.cause.code || e.message) };
  }
});

handle("cloudflared-status", async () => ({ path: await findCloudflared(), asset: cloudflaredAsset() }));
handle("install-cloudflared", async () => ({ path: await installCloudflared() }));

handle("pick-file", async (title) => {
  const res = await dialog.showOpenDialog(win, { title: String(title || "Choose a file"), properties: ["openFile"] });
  return res.canceled ? null : res.filePaths[0] || null;
});

handle("copy", (s) => { clipboard.writeText(String(s)); return true; });
handle("open-external", (url) => {
  if (/^https?:\/\//i.test(String(url))) shell.openExternal(String(url));
  return true;
});

// -------------------------------------------------------------- lifecycle
function createWindow() {
  win = new BrowserWindow({
    width: 1120, height: 760, minWidth: 820, minHeight: 560,
    title: "Plover Server", backgroundColor: "#0b0e14", show: false, autoHideMenuBar: true,
    icon: path.join(__dirname, "build", "icon.png"),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.once("ready-to-show", () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.on("close", (e) => {
    if (quitting || !anyRunning()) return;
    const n = store.servers.filter((s) => ["running", "starting"].includes(run(s.id).status)).length;
    const choice = dialog.showMessageBoxSync(win, {
      type: "question", buttons: ["Stop and quit", "Cancel"], defaultId: 0, cancelId: 1,
      message: (n === 1 ? "A server is" : n + " servers are") + " still running.",
      detail: "Quitting stops them, and anyone connected is disconnected.",
    });
    if (choice === 1) e.preventDefault();
  });
  win.on("closed", () => { win = null; });
}

let quitting = false;
app.on("before-quit", (e) => {
  if (quitting || !anyRunning()) return;
  e.preventDefault();
  quitting = true;
  Promise.all([...runs.keys()].map((id) => stopAll(id))).finally(() => app.exit(0));
});

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    createWindow();
    for (const s of store.servers) if (s.autoStart) start(s.id).catch((e) => setStatus(s.id, "error", e.message));
  });
  app.on("window-all-closed", () => app.quit());
}
