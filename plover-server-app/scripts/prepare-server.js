"use strict";
// Copies the Plover server (../plover-v1-web) into ./server, which the app runs
// in development and electron-builder ships as resources/server.
//
// The working copy of client.html carries a real access token and relay
// address, so the copy made here is reset to neutral placeholders: the app
// writes each server's own address and token into the files it hands out.
// .pixel-token, backups and scratch files are left behind. Its dependencies
// (puppeteer-core, ws) are the app's own, found through NODE_PATH: the
// packager will not ship a node_modules folder inside extraResources.

const fs = require("fs");
const path = require("path");

const SRC = path.resolve(__dirname, "..", "..", "plover-v1-web");
const OUT = path.resolve(__dirname, "..", "server");

const COPY = ["server.js", "agent.js", "lib", "package.json", "package-lock.json", "plover.svg"];
const RELAY_SKIP = new Set([".elasticbeanstalk", "node_modules"]);

const TOKEN_LINE = /const PIXEL_TOKEN = "[^"]*";/;
const SERVER_LINE = /const PIXEL_SERVER = "[^"]*";/;
const CONNECT_SRC = /connect-src [^;"]*/;
const PLACEHOLDER = "ws://127.0.0.1:8765";

function fail(msg) { console.error("prepare-server: " + msg); process.exit(1); }

if (!fs.existsSync(path.join(SRC, "server.js"))) fail("no server.js in " + SRC);

// Empties dir. On Windows a folder something has open (a terminal's or a
// process's working directory) can't be removed, so those are emptied and kept.
function clear(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 3 }); }
    catch (e) {
      if (!entry.isDirectory() || !["EBUSY", "EPERM"].includes(e.code)) throw e;
      clear(p);
    }
  }
}

fs.mkdirSync(OUT, { recursive: true });
clear(OUT);

for (const name of COPY) {
  const from = path.join(SRC, name);
  if (fs.existsSync(from)) fs.cpSync(from, path.join(OUT, name), { recursive: true });
}
fs.cpSync(path.join(SRC, "relay"), path.join(OUT, "relay"), {
  recursive: true,
  filter: (p) => !RELAY_SKIP.has(path.basename(p)),
});

let html = fs.readFileSync(path.join(SRC, "client.html"), "utf8");
for (const re of [TOKEN_LINE, SERVER_LINE, CONNECT_SRC]) {
  if (!re.test(html)) fail("client.html no longer matches " + re + "; update this script and main.js");
}
const secret = (html.match(/const PIXEL_TOKEN = "([^"]*)";/) || [])[1];
const host = (() => { try { return new URL(html.match(/const PIXEL_SERVER = "([^"]*)";/)[1]).host; } catch (_) { return ""; } })();
html = html
  .replace(TOKEN_LINE, 'const PIXEL_TOKEN = "";')
  .replace(SERVER_LINE, () => 'const PIXEL_SERVER = "' + PLACEHOLDER + '";')
  .replace(CONNECT_SRC, "connect-src " + PLACEHOLDER);
if (secret && html.includes(secret)) fail("the access token still appears in client.html after cleaning");
if (host && !host.startsWith("127.0.0.1") && html.includes(host)) fail(host + " still appears in client.html after cleaning");
fs.writeFileSync(path.join(OUT, "client.html"), html);

console.log("prepare-server: copied " + SRC + " -> " + OUT);
