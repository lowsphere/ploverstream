# Plover 

Plover is a modern, headless-browser-style web proxy, designed to be easy to use, customize, and set up.
Plover consists of two main parts.

Plover includes an installable app for running your own Plover server. It manages one or more
server profiles, runs each one's `server.js`, and
writes an HTML file with that server's address and access token filled
in, ready to hand out.


## Networking modes

| Mode | What runs | Client file connects to |
|------|-----------|-------------------------|
| **Cloudflare Tunnel** | `server.js` on 127.0.0.1 + `cloudflared tunnel --url` (quick tunnel) | `wss://<random>.trycloudflare.com`. **Changes on every start**, so download the client again after a restart. |
| **Relay** | `server.js` on 127.0.0.1 + `agent.js` dialling out to the relay | The relay's `wss://` address |
| **Custom** | `server.js` on the listen address you choose | `ws(s)://<client address>:<client port>` as you enter them |

- If `cloudflared` isn't installed, the app can download it from Cloudflare's GitHub releases into its data folder.
- Relay mode has an "I have a relay" form (address + agent secret + **Test relay**).
  It also has a "Help me set one up" guide, which generates a secret, exports the
  `relay/` folder and gives deploy steps for a VPS, Node hosts and AWS Elastic Beanstalk.
- Custom mode sets the listen address, stream/page ports, the address and port
  written into the client (so they can differ for router port forwards), and optional TLS cert/key.

## Client types

Each server profile picks what its downloaded client file is:

- **Standard**: Standard Web Proxy style browsing, autofills the credentials on download
- **Web OS**: a configurable pseudo desktop, featuring a terminal (SSH to server
  device), a browser (standard mode), custom apps written in HTML, and more!
  Web OS also comes with several design styles for you to choose from.


## Develop

```bash
cd ../plover-v1-web && npm install      # only for running server.js on its own
cd ../plover-server-app && npm install
npm start
```

`npm start` (and every `dist` script) first runs `scripts/prepare-server.js`.
That script copies `../plover-v1-web` into `./server` and **resets the token and
relay address in `client.html` to placeholders**, so your own token never
ends up in a build. `server.js`'s dependencies (`puppeteer-core`, `ws`) are this
app's own dependencies, passed to the child through `NODE_PATH`. Keep their
versions in step with `../plover-v1-web/package.json`.

`scripts/start.js` clears `ELECTRON_RUN_AS_NODE`, which VS Code's terminal sets
and which would otherwise start Electron as plain Node.

## Build an installer

```bash
npm run dist:win     # dist/Plover Server Setup <version>.exe  (NSIS)
npm run dist:mac     # .dmg   (build on macOS)
npm run dist:linux   # AppImage + .deb
```

`build/icon.png` is generated from the Plover mark by `npx electron scripts/make-icon.js`.
The installer is unsigned, so Windows SmartScreen will warn on first run.

## Where things live

- Profiles (including tokens and relay secrets): `servers.json` in the app's
  user-data folder (`%APPDATA%\Plover Server` on Windows). Set `PLOVER_DATA_DIR`
  to use another folder.
- A downloaded `cloudflared`: `bin/` in the same folder.
- Chromium: the server uses the installed Chrome/Edge unless a path is set
  under Settings.
