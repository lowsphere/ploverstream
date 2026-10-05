"use strict";
// Shell sessions for the Web OS Terminal app. A connection that authenticates
// with mode "terminal" (the access token plus the terminal password) gets a
// shell on this machine, running as whoever runs server.js, for as long as its
// socket stays open, much like an ssh session.
//
// The shell runs on plain pipes, not a pseudo-terminal, so line-based commands
// work but full-screen programs (vim, top, less) do not. The client edits and
// echoes each line itself and sends it on Enter.
//
// Messages (pixel-protocol control frames, JSON):
//   client -> server  {t:"term.in", d}   text for the shell's stdin
//                     {t:"term.int"}     Ctrl+C
//   server -> client  {t:"term.ready", user, host, shell}
//                     {t:"term.out", d}  shell output (stdout and stderr)
//                     {t:"term.note", d} a line from the server itself
//                     {t:"term.exit", code}
//
// The password is never stored: server.js gets TERMINAL_PASS_HASH, made by
//   node lib/terminal.js            (reads the password from stdin)
// or by Plover Server when a terminal password is set there.

const crypto = require("crypto");
const os = require("os");
const { spawn, execFile } = require("child_process");
const { StringDecoder } = require("string_decoder");

const WIN = process.platform === "win32";
const SCRYPT = { N: 16384, r: 8, p: 1 };
const MAX_INPUT = 64 * 1024;
const HIGH_WATER = 2 << 20;   // bytes queued on the socket before the shell's output is paused

// Variables the server runs with that a shell has no business seeing.
const PRIVATE_ENV = ["PIXEL_TOKEN", "TERMINAL_PASS_HASH", "AGENT_SECRET", "PORT", "HTTP_PORT", "HOST", "MAX_SESSIONS",
  "SESSION_IDLE_MIN", "CHROME_PATH", "TLS_CERT", "TLS_KEY", "ALLOWED_ORIGINS", "PIXEL_DELAY_MS", "ELECTRON_RUN_AS_NODE", "NODE_PATH"];

// ------------------------------------------------------------- passwords
const b64 = (buf) => buf.toString("base64url");

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, 32, SCRYPT, (err, key) => {
      if (err) reject(err);
      else resolve(["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, b64(salt), b64(key)].join("$"));
    });
  });
}

// "scrypt$N$r$p$salt$key" -> its parts, or null if it isn't one.
function parseHash(s) {
  const m = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9_-]{16,})\$([A-Za-z0-9_-]{32,})$/.exec(String(s || ""));
  if (!m) return null;
  const [N, r, p] = [m[1], m[2], m[3]].map(Number);
  if (N < 1024 || N > 1 << 20 || (N & (N - 1)) || r < 1 || r > 32 || p < 1 || p > 16) return null;
  return { N, r, p, salt: Buffer.from(m[4], "base64url"), key: Buffer.from(m[5], "base64url") };
}

function verifyPassword(password, spec) {
  return new Promise((resolve) => {
    const pw = typeof password === "string" ? password.slice(0, 1024) : "";
    const maxmem = 256 * spec.N * spec.r + (1 << 20);
    crypto.scrypt(pw, spec.salt, spec.key.length, { N: spec.N, r: spec.r, p: spec.p, maxmem }, (err, key) => {
      resolve(!err && crypto.timingSafeEqual(key, spec.key));
    });
  });
}

// ----------------------------------------------------------------- shell
function shellCommand() {
  if (WIN) return { file: process.env.ComSpec || "cmd.exe", args: ["/Q", "/K", "chcp 65001>nul"], name: "cmd" };
  const sh = process.env.SHELL && /^\/[\w./-]+$/.test(process.env.SHELL) ? process.env.SHELL : "/bin/sh";
  return { file: sh, args: ["-i"], name: sh.split("/").pop() };
}

function shellEnv() {
  const env = { ...process.env, TERM: "dumb", PAGER: "cat", GIT_PAGER: "cat" };
  for (const k of PRIVATE_ENV) delete env[k];
  return env;
}

function killTree(child, signal) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (WIN) execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
  else try { process.kill(-child.pid, signal || "SIGKILL"); } catch (_) { try { child.kill("SIGKILL"); } catch (_) {} }
}

class Terminal {
  constructor(conn, { log, onClose }) {
    this.conn = conn; this.log = log; this.onClose = onClose;
    this.child = null; this.closed = false; this.paused = false; this.restarting = false;
  }

  start() {
    const { file, args, name } = shellCommand();
    this.conn.send({ t: "term.ready", user: os.userInfo().username, host: os.hostname(), shell: name });
    this.spawn(file, args);
  }

  spawn(file, args) {
    // detached on Unix puts the shell in its own process group, so Ctrl+C and
    // closing can signal everything it started.
    const child = spawn(file, args, { cwd: os.homedir(), env: shellEnv(), windowsHide: true, detached: !WIN });
    this.child = child;
    const pipe = (stream) => {
      const dec = new StringDecoder("utf8");
      stream.on("data", (b) => { this.out(dec.write(b)); this.throttle(); });
      stream.on("end", () => this.out(dec.end()));
    };
    pipe(child.stdout); pipe(child.stderr);
    child.stdin.on("error", () => {});
    child.on("error", (e) => { this.note("could not start the shell: " + e.message); this.close(1011, "no shell"); });
    child.on("exit", (code, signal) => {
      if (this.child !== child || this.closed) return;
      if (this.restarting) { this.restarting = false; this.spawn(file, args); return; }
      this.conn.send({ t: "term.exit", code: code == null ? signal : code });
      this.close(1000, "shell exited");
    });
  }

  out(d) { if (d) this.conn.send({ t: "term.out", d }); }
  note(d) { this.conn.send({ t: "term.note", d }); }

  // A command that floods output must not fill the server's memory: stop
  // reading from the shell until the socket drains.
  throttle() {
    if (this.paused || this.conn.buffered() < HIGH_WATER) return;
    this.paused = true;
    const c = this.child;
    c.stdout.pause(); c.stderr.pause();
    const wait = setInterval(() => {
      if (this.closed || this.conn.buffered() < HIGH_WATER / 4) {
        clearInterval(wait); this.paused = false;
        if (!this.closed) { c.stdout.resume(); c.stderr.resume(); }
      }
    }, 50);
  }

  handle(m) {
    if (this.closed || !this.child) return;
    if (m.t === "term.in" && typeof m.d === "string") {
      if (this.child.stdin.writable) this.child.stdin.write(m.d.slice(0, MAX_INPUT));
    } else if (m.t === "term.int") this.interrupt();
    else if (m.t === "ping") this.conn.send({ t: "pong", ts: m.ts });
  }

  // Unix: SIGINT to the shell's process group; an interactive shell ignores
  // it, the command it is running does not. Windows has no way to send Ctrl+C
  // down a pipe, so the shell and whatever it started are ended and a new one
  // starts in their place.
  interrupt() {
    const c = this.child;
    if (!WIN) { try { process.kill(-c.pid, "SIGINT"); } catch (_) {} return; }
    if (this.restarting) return;
    this.restarting = true;
    this.note("Stopped. Windows can't pass Ctrl+C to a running command, so the shell was restarted in your home folder.");
    killTree(c);
  }

  close(code, reason) {
    if (this.closed) return;
    this.closed = true;
    const c = this.child;
    if (c) {
      if (!WIN) killTree(c, "SIGHUP");
      setTimeout(() => killTree(c), WIN ? 0 : 2000).unref();
    }
    if (code) this.conn.close(code, reason);
    if (this.onClose) this.onClose(this);
  }
}

module.exports = { Terminal, hashPassword, parseHash, verifyPassword };

// node lib/terminal.js  ->  prints a TERMINAL_PASS_HASH for the password on stdin
if (require.main === module) {
  let input = "";
  if (process.stdin.isTTY) process.stderr.write("Terminal password: ");
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => { input += d; if (input.includes("\n")) { process.stdin.pause(); done(); } });
  process.stdin.on("end", done);
  let printed = false;
  function done() {
    if (printed) return;
    printed = true;
    const pw = input.split(/\r?\n/)[0];
    if (pw.length < 8) { console.error("Use at least 8 characters."); process.exit(1); }
    hashPassword(pw).then((h) => { console.log(h); process.exit(0); });
  }
}
