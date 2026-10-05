"use strict";
// Plover Server window. Everything that touches the disk, processes or the
// network goes through window.plover (preload.js) to main.js.

const api = window.plover;
const $ = (sel) => document.querySelector(sel);

const S = {
  servers: [],
  runtime: {},          // id -> {status, message, clientUrl, agentUp, procs}
  selected: null,       // server id, or "new"
  tab: "overview",
  draft: null,          // profile being edited (create view, networking, settings)
  errors: [],
  showToken: false,
  relayView: "have",    // "have" | "setup"
  relayTest: null,
  cf: null,             // {path, asset}
  cfProgress: null,     // {got, total} while downloading
  logs: [],
  styles: {},           // Web OS looks from main.js: key -> {name, accents}
};

const KINDS = {
  standard: {
    title: "Standard",
    desc: "The Plover browser on its own, filling the page: a tab sidebar and the stream.",
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/></svg>',
  },
  webos: {
    title: "Web OS",
    desc: "A desktop in a page, with files, a text editor and the Plover browser in its own window.",
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="14" rx="2"/><path d="M8 21h8M12 17v4M7 7h4v4H7z"/></svg>',
  },
};

const MODES = {
  tunnel: {
    title: "Cloudflare Tunnel",
    desc: "Easiest. A free trycloudflare.com address. No account, port forwarding or router setup.",
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19a4.5 4.5 0 1 0-1.4-8.78A6 6 0 0 0 4.5 13 3 3 0 0 0 6 19z"/></svg>',
  },
  relay: {
    title: "Relay",
    desc: "Your server dials out to a relay you host, or one you've been given. Stable address, no port forwarding.",
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="12" r="2"/><circle cx="19" cy="12" r="2"/><circle cx="12" cy="5" r="2"/><path d="M6.5 10.5 10.5 6.5M13.5 6.5l4 4M7 12h10"/></svg>',
  },
  custom: {
    title: "Custom",
    desc: "Pick the listen address, ports and the address clients use. You handle port forwarding, firewall and DNS.",
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/></svg>',
  },
};
const STATUS_LABEL = { stopped: "Stopped", starting: "Starting", running: "Running", error: "Error" };

// ---------------------------------------------------------------- helpers
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const clone = (o) => JSON.parse(JSON.stringify(o));
const current = () => S.servers.find((s) => s.id === S.selected) || null;
const rt = (id) => S.runtime[id] || { status: "stopped", message: "", clientUrl: null, procs: {} };
const isLive = (id) => ["running", "starting"].includes(rt(id).status);

function getPath(obj, p) { return p.split(".").reduce((o, k) => (o == null ? o : o[k]), obj); }
function setPath(obj, p, v) {
  const ks = p.split("."), last = ks.pop();
  ks.reduce((o, k) => o[k], obj)[last] = v;
}

let toastTimer = 0;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

function secret() {
  const b = new Uint8Array(24); crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// What a client file built from this profile would connect to, as far as
// the form can tell (a quick tunnel's address only exists once it is up).
function previewUrl(p) {
  const n = p.network;
  if (n.mode === "relay") return n.relay.url || "";
  if (n.mode === "custom") return n.custom.publicHost ? (n.custom.tls ? "wss://" : "ws://") + n.custom.publicHost + ":" + n.custom.publicPort : "";
  return "";
}

const dirty = () => {
  const s = current();
  return !!(s && S.draft && JSON.stringify(s) !== JSON.stringify(S.draft));
};

// ----------------------------------------------------------------- render
function render() {
  renderSidebar();
  renderMain();
}

function renderSidebar() {
  const list = $("#server-list");
  if (!S.servers.length) { list.innerHTML = '<li class="empty-side">No servers yet.</li>'; return; }
  list.innerHTML = S.servers.map((s) => {
    const r = rt(s.id);
    return '<li class="server-item' + (s.id === S.selected ? " active" : "") + '" data-action="select" data-id="' + esc(s.id) + '">' +
      '<span class="dot ' + r.status + '"></span>' +
      '<div class="meta"><div class="nm">' + esc(s.name) + '</div><div class="sub">' + (s.kind === "webos" ? "Web OS · " : "") +
      MODES[s.network.mode].title + " · " + STATUS_LABEL[r.status] + "</div></div></li>";
  }).join("");
}

function renderMain() {
  const m = $("#main");
  if (S.selected === "new") { m.innerHTML = createView(); paintOs(); return; }
  const s = current();
  if (!s) { m.innerHTML = emptyView(); return; }
  m.innerHTML = '<div id="head"></div><nav class="tabs" id="tabs"></nav><div id="body"></div>';
  renderHead(); renderTabs(); renderBody();
}

function renderHead() {
  const s = current(), el = $("#head");
  if (!s || !el) return;
  const r = rt(s.id), live = isLive(s.id);
  el.className = "head";
  el.innerHTML =
    "<h1>" + esc(s.name) + "</h1>" +
    '<span class="pill ' + r.status + '"><span class="dot ' + r.status + '"></span>' + STATUS_LABEL[r.status] + "</span>" +
    '<span class="grow"></span>' +
    (live
      ? '<button class="btn" data-action="restart">Restart</button><button class="btn" data-action="stop">Stop</button>'
      : '<button class="btn primary" data-action="start">Start server</button>') +
    '<button class="btn" data-action="download"' + (r.clientUrl ? "" : " disabled") + ' title="' +
      (r.clientUrl ? "Save a client file that connects to this server" : s.network.mode === "tunnel" ? "Start the server to get its tunnel address" : "Finish the networking settings first") +
      '">Download client HTML</button>';
}

function renderTabs() {
  const el = $("#tabs");
  if (!el) return;
  el.innerHTML = [["overview", "Overview"], ["network", "Networking"], ["settings", "Settings"], ["logs", "Logs"]]
    .map(([k, label]) => '<button class="tab' + (S.tab === k ? " active" : "") + '" data-action="tab" data-tab="' + k + '">' + label + "</button>").join("");
}

function renderBody() {
  const el = $("#body"), s = current();
  if (!el || !s) return;
  if (S.tab === "overview") el.innerHTML = overview(s);
  else if (S.tab === "network") el.innerHTML = errorsBanner() + restartBanner(s) + networkForm(S.draft) + saveBar();
  else if (S.tab === "settings") el.innerHTML = errorsBanner() + restartBanner(s) + clientForm(S.draft) + (S.draft.kind === "webos" ? terminalCard(s) : "") +
    settingsForm(S.draft) + saveBar() + dangerZone();
  else { el.innerHTML = logsView(); scrollLogs(true); }
  paintOs();
}

function errorsBanner() {
  if (!S.errors.length) return "";
  return '<div class="banner error"><strong>Please fix the following:</strong><ul>' + S.errors.map((e) => "<li>" + esc(e) + "</li>").join("") + "</ul></div>";
}

function restartBanner(s) {
  return isLive(s.id) ? '<div class="banner warn">This server is running. Saved changes take effect when you restart it.</div>' : "";
}

function saveBar() {
  return '<div class="savebar"><span class="muted small" id="dirty-note">' + (dirty() ? "Unsaved changes" : "") + "</span>" +
    '<button class="btn" data-action="revert" id="btn-revert"' + (dirty() ? "" : " disabled") + ">Discard</button>" +
    '<button class="btn primary" data-action="save" id="btn-save"' + (dirty() ? "" : " disabled") + ">Save changes</button></div>";
}

function emptyView() {
  return '<div class="empty">' + $(".brand .logo").outerHTML +
    "<h1>Run your own Plover server</h1>" +
    "<p>A server runs a headless Chromium on this computer and streams it to the Plover client. Create one, choose how people reach it, then hand out the client file: the standard Plover browser, or a Web OS desktop with the browser inside. It comes pre-filled with the server's address and access key.</p>" +
    '<button class="btn primary" data-action="new">Create a server</button></div>';
}

// ---------------------------------------------------------------- overview
function overview(s) {
  const r = rt(s.id), n = s.network, live = isLive(s.id);
  let out = "";
  if (r.status === "error") out += '<div class="banner error">' + esc(r.message || "Something went wrong. See Logs.") + "</div>";
  else if (r.message) out += '<div class="banner' + (r.status === "running" ? " warn" : "") + '">' + esc(r.message) + "</div>";

  const url = r.clientUrl;
  out += '<div class="card"><h2>Client file</h2>' +
    '<p class="lead">' + (s.kind === "webos"
      ? "A Web OS desktop (" + esc(styleName(s.webos.style)) + ") whose Browser app connects to this server with its access token filled in."
      : "A copy of the Plover client with this server's address and access token filled in.") +
    " Open it in any modern browser; nothing to install.</p>";
  if (url) {
    out += '<div class="row"><div class="value grow"><span class="muted small">Connects to</span><span class="mono">' + esc(url) + "</span>" +
      '<button class="btn sm" data-action="copy" data-value="' + esc(url) + '">Copy</button></div>' +
      '<button class="btn primary" data-action="download">Download client HTML</button></div>';
    if (n.mode === "tunnel") out += '<p class="small muted">Quick tunnel addresses change every time the server starts. After a restart, download the client again; older copies stop working.</p>';
    if (n.mode === "custom" && !n.custom.tls) out += '<p class="small muted">Without TLS, the token and the stream cross the network unencrypted. Fine on a home network. Turn on TLS under Networking before using this over the internet.</p>';
  } else if (n.mode === "tunnel") {
    out += '<div class="banner">' + (live ? "Waiting for Cloudflare to hand out an address…" : "Start the server to get a tunnel address. The download becomes available once it is up.") + "</div>";
  } else {
    out += '<div class="banner warn">Finish the Networking settings to get a client file.</div>';
  }
  out += '<p class="small muted">The file contains the access token. Anyone who has it can use this server, so share it only with people you trust.</p></div>';

  out += '<div class="card"><h2>Access token</h2><p class="lead">Every client must present this token. Regenerating it locks out every client file handed out so far.</p>' +
    '<div class="row"><div class="value grow"><span class="mono">' + (S.showToken ? esc(s.token) : "•".repeat(24)) + "</span>" +
    '<button class="btn sm" data-action="toggle-token">' + (S.showToken ? "Hide" : "Show") + "</button>" +
    '<button class="btn sm" data-action="copy" data-value="' + esc(s.token) + '">Copy</button></div>' +
    '<button class="btn" data-action="regen">Regenerate</button></div></div>';

  const page = "http://127.0.0.1:" + n.pagePort + "/#token=" + s.token;
  const bind = n.mode === "custom" ? n.custom.bindHost : "127.0.0.1";
  out += '<div class="card"><h2>At a glance</h2><div class="grid2">' +
    kv("Client", s.kind === "webos" ? "Web OS · " + styleName(s.webos.style) + " · " + s.webos.accent : "Standard") +
    (s.kind === "webos" ? kv("Terminal", s.terminal.hash ? "On, with a password" : "Off (no password set)") : "") +
    (s.kind === "webos" ? kv("Installed apps", s.webos.apps.length ? s.webos.apps.map((a) => a.name).join(", ") : "None") : "") +
    kv("Networking", MODES[n.mode].title) +
    kv("Listens on", bind + " : " + n.streamPort + " (stream), " + n.pagePort + " (page)") +
    kv("Sessions", "Up to " + s.maxSessions + " at once; idle ones close after " + s.idleMin + " min") +
    kv("Browser", s.chromePath || "Chrome / Edge, found automatically") +
    "</div>" +
    (r.status === "running"
      ? '<div class="row"><button class="btn sm" data-action="open-page" data-value="' + esc(page) + '">Open on this computer</button>' +
        '<span class="small muted">Opens the client served by this server in your default browser.</span></div>'
      : "") + "</div>";
  return out;
}

function kv(k, v) { return '<div class="field"><label>' + esc(k) + '</label><div class="muted">' + esc(v) + "</div></div>"; }

// ------------------------------------------------------------- networking
function networkForm(d) {
  const n = d.network;
  let out = '<div class="card"><h2>How will clients reach this server?</h2><p class="lead">You can change this later. The client file always follows the current setting.</p><div class="modes">' +
    Object.entries(MODES).map(([k, m]) =>
      '<button class="mode' + (n.mode === k ? " active" : "") + '" data-action="mode" data-mode="' + k + '" aria-pressed="' + (n.mode === k) + '">' +
      '<span class="t">' + m.icon + m.title + '</span><span class="d">' + m.desc + "</span></button>").join("") +
    "</div>";
  out += n.mode === "tunnel" ? tunnelPanel() : n.mode === "relay" ? relayPanel(d) : customPanel(d);
  out += "</div>";

  out += '<div class="card"><h2>Ports on this computer</h2>' +
    '<p class="lead">' + (n.mode === "custom"
      ? "The server listens on these. The stream port is the one clients connect to (directly, or via your port forward)."
      : "Used on this computer only. " + (n.mode === "tunnel" ? "The tunnel" : "The relay agent") + " connects to the stream port locally, so nothing needs forwarding.") + "</p>" +
    '<div class="grid2">' +
    field("Stream port", '<input type="number" min="1" max="65535" data-bind="network.streamPort" value="' + n.streamPort + '">', "The pixel stream (WebSocket).") +
    field("Page port", '<input type="number" min="1" max="65535" data-bind="network.pagePort" value="' + n.pagePort + '">', "Serves the client page to browsers on this computer (and your network, in Custom mode).") +
    "</div></div>";

  const url = previewUrl(d);
  out += '<div class="banner" id="preview">' + previewText(d, url) + "</div>";
  return out;
}

function previewText(d, url) {
  if (d.network.mode === "tunnel") return "The client file will connect to the <strong>trycloudflare.com</strong> address Cloudflare assigns when the server starts.";
  return url ? "The client file will connect to <span class=\"mono\">" + esc(url) + "</span>." : "Fill in the address above to see where client files will connect.";
}

function field(label, control, hint) {
  return '<div class="field"><label>' + label + "</label>" + control + (hint ? '<span class="hint">' + hint + "</span>" : "") + "</div>";
}

function tunnelPanel() {
  let out = "";
  if (!S.cf) out += '<div class="banner">Looking for cloudflared…</div>';
  else if (S.cf.path) out += '<div class="banner ok">cloudflared is installed: <span class="mono">' + esc(S.cf.path) + "</span></div>";
  else if (S.cfProgress) {
    const pct = S.cfProgress.total ? Math.round(S.cfProgress.got / S.cfProgress.total * 100) : 0;
    out += '<div class="banner">Downloading cloudflared… ' + (S.cfProgress.total ? pct + "%" : Math.round(S.cfProgress.got / 1048576) + " MB") +
      '<div class="progress"><div data-pct="' + pct + '"></div></div></div>';
  } else {
    out += '<div class="banner warn"><div class="row"><span class="grow">The tunnel needs Cloudflare\'s free <strong>cloudflared</strong> program, which isn\'t installed yet.</span>' +
      '<button class="btn primary sm" data-action="install-cf">Install cloudflared</button></div>' +
      '<div class="small muted mt6">Downloads <span class="mono">' + esc(S.cf.asset) + "</span> from Cloudflare's GitHub releases into this app's data folder.</div></div>";
  }
  out += '<ul class="small muted bullets">' +
    "<li>When the server starts, Cloudflare hands out a random address such as <span class=\"mono\">wss://calm-river-1234.trycloudflare.com</span> (encrypted).</li>" +
    "<li>That address changes on every start. Download the client file again after each restart.</li>" +
    "<li>Quick tunnels are for personal use and testing. For a permanent address, use a Relay or Custom networking.</li></ul>";
  return out;
}

function relayPanel(d) {
  const r = d.network.relay;
  let out = '<div class="seg" role="tablist">' +
    '<button class="' + (S.relayView === "have" ? "active" : "") + '" data-action="relay-view" data-view="have">I have a relay</button>' +
    '<button class="' + (S.relayView === "setup" ? "active" : "") + '" data-action="relay-view" data-view="setup">Help me set one up</button></div>';

  const fields =
    field("Relay address", '<input type="text" spellcheck="false" placeholder="wss://relay.example.com" data-bind="network.relay.url" value="' + esc(r.url) + '">',
      "The relay's public address with no path. Clients and this server both connect to it. Use <span class=\"mono\">wss://</span> so traffic is encrypted.") +
    field("Agent secret",
      '<div class="row"><input class="grow" type="text" spellcheck="false" data-bind="network.relay.secret" value="' + esc(r.secret) + '">' +
      (S.relayView === "setup" ? '<button class="btn" data-action="gen-secret">Generate</button>' : "") + "</div>",
      "Must match the relay's <span class=\"mono\">AGENT_SECRET</span>. Only this server should know it. Clients never need it.") +
    '<label class="check"><input type="checkbox" data-bind="network.relay.insecure"' + (r.insecure ? " checked" : "") + ">" +
    '<span>Accept a self-signed certificate on the relay<br><span class="small muted">Only for relays you run yourself without a real certificate.</span></span></label>' +
    '<div class="row"><button class="btn" data-action="test-relay">Test relay</button><span id="relay-test" class="small">' + relayTestText() + "</span></div>";

  if (S.relayView === "have") {
    return out + '<p class="lead">Enter the details from whoever runs the relay.</p>' + fields +
      '<p class="small muted">A relay serves one Plover server at a time. If someone else\'s server is already connected to it, yours replaces theirs.</p>';
  }

  const sec = r.secret || "<your-secret>";
  out += '<p class="lead">A relay is a small Node.js program on any machine with a public address (a cheap VPS, a cloud app platform or AWS). It passes the stream through and never sees your access token.</p>' +
    '<ol class="steps">' +
    "<li><h3>Create a secret</h3><p>The relay uses it to know your server is really yours.</p>" +
    '<div class="row"><button class="btn sm" data-action="gen-secret">Generate secret</button>' + (r.secret ? '<button class="btn sm" data-action="copy" data-value="' + esc(r.secret) + '">Copy secret</button>' : "") + "</div></li>" +
    "<li><h3>Get the relay files</h3><p>Exports a <span class=\"mono\">plover-relay</span> folder containing <span class=\"mono\">relay.js</span>, its <span class=\"mono\">package.json</span>, and ready-made AWS Elastic Beanstalk config.</p>" +
    '<button class="btn sm" data-action="export-relay">Export relay files…</button></li>' +
    "<li><h3>Deploy it</h3><p>Pick whichever fits. The relay needs Node.js 18 or newer and must accept WebSocket connections.</p>" +
    '<details class="host" open><summary>Any Linux server / VPS</summary><div>' +
    '<p class="small muted">Copy the folder over, then:</p>' +
    '<pre class="cmd">cd plover-relay\nnpm install --omit=dev\nAGENT_SECRET=' + esc(sec) + " PORT=8080 node relay.js</pre>" +
    '<p class="small muted">Put TLS in front so you get a <span class="mono">wss://</span> address. With a domain pointed at the server, <a href="#" data-action="ext" data-value="https://caddyserver.com/docs/install">Caddy</a> does it in one line:</p>' +
    '<pre class="cmd">caddy reverse-proxy --from relay.example.com --to :8080</pre>' +
    '<p class="small muted">Keep it running with systemd, pm2 or similar.</p></div></details>' +
    '<details class="host"><summary>Render, Railway, Fly.io or another Node host</summary><div>' +
    '<p class="small muted">Create a Node web service from the <span class="mono">plover-relay</span> folder (push it to a Git repo first if the host needs one).</p>' +
    '<pre class="cmd">Build command:  npm install\nStart command:  node relay.js\nEnvironment:    AGENT_SECRET=' + esc(sec) + "</pre>" +
    '<p class="small muted">The host provides HTTPS. Your relay address is its URL with <span class="mono">https://</span> changed to <span class="mono">wss://</span>. Run a single instance only. Turn off sleep/scale-to-zero, or the relay will drop your server.</p></div></details>' +
    '<details class="host"><summary>AWS Elastic Beanstalk</summary><div>' +
    '<p class="small muted">With the <a href="#" data-action="ext" data-value="https://docs.aws.amazon.com/elasticbeanstalk/latest/dg/eb-cli3-install.html">EB CLI</a> installed, from the exported folder:</p>' +
    '<pre class="cmd">eb init plover-relay --platform node.js --region us-east-1\neb create plover-relay-env --elb-type application\neb setenv AGENT_SECRET=' + esc(sec) + "\neb scale 1\neb deploy</pre>" +
    '<p class="small muted">For <span class="mono">wss://</span>, add an HTTPS listener (port 443, an ACM certificate for your domain) to the load balancer and point your domain at the environment. The folder\'s README.md has the details.</p></div></details></li>' +
    '<li><h3>Connect this server</h3><p>Enter the relay\'s address and the same secret, then test it. "Relay reachable" means it\'s ready. Start this server and the relay will show it as connected.</p>' + fields + "</li></ol>";
  return out;
}

function relayTestText() {
  const t = S.relayTest;
  if (!t) return "";
  if (t === "busy") return '<span class="muted">Testing…</span>';
  if (!t.ok) return '<span class="c-bad">' + esc(t.msg) + "</span>";
  return '<span class="c-ok">Relay reachable</span> <span class="muted">— a server is ' + (t.agentUp ? "connected to it right now" : "not connected yet") + ".</span>";
}

function customPanel(d) {
  const c = d.network.custom;
  const forward = c.publicPort !== d.network.streamPort;
  return '<p class="lead">The server listens directly on this computer. Clients connect to the address and port you give below. To reach it from the internet, forward that port on your router to this computer\'s stream port and allow it through the firewall.</p>' +
    '<div class="grid2">' +
    field("Listen address",
      '<input type="text" list="bind-hosts" spellcheck="false" data-bind="network.custom.bindHost" value="' + esc(c.bindHost) + '">' +
      '<datalist id="bind-hosts"><option value="0.0.0.0">All IPv4 interfaces</option><option value="::">All interfaces (IPv4 + IPv6)</option><option value="127.0.0.1">This computer only</option></datalist>',
      "Which of this computer's network interfaces the server accepts connections on. <span class=\"mono\">0.0.0.0</span> means all of them.") +
    "<div></div></div>" +
    '<div class="grid3">' +
    field("Clients connect to", '<input type="text" spellcheck="false" placeholder="203.0.113.7 or plover.example.com" data-bind="network.custom.publicHost" value="' + esc(c.publicHost) + '">',
      "Your public IP, a domain name or a LAN address like 192.168.1.20. This is written into the client file.") +
    field("Client port", '<input type="number" min="1" max="65535" data-bind="network.custom.publicPort" value="' + c.publicPort + '">',
      "Usually the same as the stream port.") +
    "</div>" +
    '<p class="small muted" id="forward-hint"' + (forward ? "" : " hidden") + ">Clients use port <strong>" + c.publicPort + "</strong> but the server listens on <strong>" + d.network.streamPort +
    "</strong>, so your router must forward external port " + c.publicPort + " to this computer's port " + d.network.streamPort + ".</p>" +
    '<label class="check"><input type="checkbox" data-bind="network.custom.tls" data-rerender' + (c.tls ? " checked" : "") + ">" +
    '<span>Use TLS (<span class="mono">wss://</span>)<br><span class="small muted">Encrypts the token and the stream. Needs a certificate for the client address, e.g. from Let\'s Encrypt.</span></span></label>' +
    (c.tls
      ? '<div class="grid2">' +
        field("Certificate (PEM)", '<div class="row"><input class="grow" type="text" data-bind="network.custom.certPath" value="' + esc(c.certPath) + '"><button class="btn" data-action="pick" data-bind="network.custom.certPath">Browse</button></div>') +
        field("Private key (PEM)", '<div class="row"><input class="grow" type="text" data-bind="network.custom.keyPath" value="' + esc(c.keyPath) + '"><button class="btn" data-action="pick" data-bind="network.custom.keyPath">Browse</button></div>') +
        "</div>"
      : "");
}

// ----------------------------------------------------------------- client
const WP_MAX = 1920;
const styleName = (k) => (S.styles[k] ? S.styles[k].name : k);

// Reads a picture and re-encodes it as a JPEG data URL no bigger than WP_MAX
// on its long side. (This page's CSP allows data: images, not blob: ones.)
function encodePicture(file) {
  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error(file.name + " isn't a picture that can be opened."));
    const reader = new FileReader();
    reader.onerror = fail;
    reader.onload = () => {
      const im = new Image();
      im.onerror = fail;
      im.onload = () => {
        const k = Math.min(1, WP_MAX / Math.max(im.naturalWidth, im.naturalHeight));
        const c = document.createElement("canvas"), g = c.getContext("2d");
        c.width = Math.max(1, Math.round(im.naturalWidth * k));
        c.height = Math.max(1, Math.round(im.naturalHeight * k));
        g.fillStyle = "#000";
        g.fillRect(0, 0, c.width, c.height);
        g.drawImage(im, 0, 0, c.width, c.height);
        resolve(c.toDataURL("image/jpeg", 0.85));
      };
      im.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
const styleAccents = (k) => (S.styles[k] ? S.styles[k].accents : []);

function clientForm(d) {
  let out = '<div class="card"><h2>Client</h2><p class="lead">What the downloaded client file opens as. Changes here apply to files you download from now on; the server does not need a restart.</p>' +
    '<div class="modes two">' +
    Object.entries(KINDS).map(([k, m]) =>
      '<button class="mode' + (d.kind === k ? " active" : "") + '" data-action="kind" data-kind="' + k + '" aria-pressed="' + (d.kind === k) + '">' +
      '<span class="t">' + m.icon + m.title + '</span><span class="d">' + m.desc + "</span></button>").join("") +
    "</div>";
  if (d.kind === "webos") {
    out += '<div class="field"><label>Style</label><div class="os-styles">' +
      Object.keys(S.styles).map((k) =>
        '<button class="os-style' + (d.webos.style === k ? " active" : "") + '" data-action="os-style" data-style="' + k + '" aria-pressed="' + (d.webos.style === k) + '">' +
        '<span class="os-thumb ' + k + '" data-thumb="' + k + '"><i class="t-bar"></i><i class="t-clock"></i><i class="t-win"></i><i class="t-dock"><b></b></i></span>' +
        '<span class="nm">' + esc(styleName(k)) + "</span></button>").join("") +
      "</div></div>" +
      '<div class="field"><label>Accent color</label><div class="row">' +
      styleAccents(d.webos.style).map((c) =>
        '<button class="swatch" data-action="os-accent" data-value="' + c + '" data-swatch="' + c + '" title="' + c + '" aria-label="Accent ' + c + '"></button>').join("") +
      '<label class="swatch custom" title="Pick any color"><input type="color" data-bind="webos.accent" value="' + esc(d.webos.accent) + '" aria-label="Custom accent"></label>' +
      '<span class="mono muted" id="accent-hex"></span></div>' +
      '<span class="hint">People using the desktop can change the style and accent in its Settings app. This is what it starts with.</span></div>' +
      '<div class="field"><label>Wallpaper</label><div class="row">' +
      (d.webos.wallpaper ? '<img class="wp-prev" alt="Wallpaper" src="' + esc(d.webos.wallpaper) + '">' : '<span class="wp-prev none">The style’s own backdrop</span>') +
      '<button class="btn" data-action="wp-import">' + (d.webos.wallpaper ? "Change picture…" : "Choose picture…") + "</button>" +
      (d.webos.wallpaper ? '<button class="btn danger" data-action="wp-clear">Remove</button>' : "") +
      '</div><span class="hint">Built into the client file, shrunk to fit ' + WP_MAX + ' pixels. People can still pick their own in the desktop’s Settings app.</span></div>' +
      appsField(d);
  }
  return out + "</div>";
}

// ------------------------------------------------------------------- apps
// Extra Web OS apps, each a single HTML file built into the client file. The
// desktop runs each in a sandboxed frame. Limits match main.js.
const APP_MAX = 5 * 1024 * 1024, APPS_MAX = 12, APPS_TOTAL = 24 * 1024 * 1024;
const fmtSize = (n) => (n < 1048576 ? Math.max(1, Math.round(n / 1024)) + " KB" : (n / 1048576).toFixed(1) + " MB");

function appsField(d) {
  const apps = d.webos.apps;
  return '<div class="field"><label>Apps</label>' +
    (apps.length ? '<div class="app-list">' + apps.map((a, i) =>
      '<div class="app-row">' +
      (a.icon ? '<img class="app-ic" alt="" src="' + esc(a.icon) + '">' : '<span class="app-ic none">' + esc((a.name || "?").slice(0, 1).toUpperCase()) + "</span>") +
      '<input class="grow" type="text" maxlength="40" data-bind="webos.apps.' + i + '.name" value="' + esc(a.name) + '" aria-label="App name">' +
      '<span class="small muted">' + fmtSize(a.html.length) + "</span>" +
      '<button class="btn sm" data-action="app-replace" data-index="' + i + '" title="Swap in a new version of this app; its saved data stays">Replace…</button>' +
      '<button class="btn sm danger" data-action="app-remove" data-index="' + i + '">Remove</button></div>').join("") + "</div>" : "") +
    '<div class="row"><button class="btn" data-action="app-add"' + (apps.length >= APPS_MAX ? " disabled" : "") + ">Add app…</button></div>" +
    '<span class="hint">Single HTML files, added to the desktop next to its own apps and built into the client file. Each must be self-contained ' +
    "(scripts, styles and images inside the file): installed apps can’t load anything from the internet. Up to " + APPS_MAX + " apps, " + fmtSize(APP_MAX) + " each.</span></div>";
}

function pickHtml() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file"; input.accept = ".html,.htm,text/html";
    input.addEventListener("change", () => resolve(input.files[0] || null));
    input.click();
  });
}

// Reads an app file: its name from <title> (or the file name), and its icon
// from a data: <link rel="icon">, redrawn as a 64 px PNG.
async function readApp(file) {
  if (file.size > APP_MAX) throw new Error(file.name + " is " + fmtSize(file.size) + "; apps can be up to " + fmtSize(APP_MAX) + ".");
  const html = await file.text();
  if (!html.trim()) throw new Error(file.name + " is empty.");
  const doc = new DOMParser().parseFromString(html, "text/html");
  const name = (doc.title || "").trim() || file.name.replace(/\.html?$/i, "");
  const link = doc.querySelector('link[rel~="icon" i]');
  const href = link ? link.getAttribute("href") || "" : "";
  const icon = /^data:image\//i.test(href) ? await iconPng(href).catch(() => "") : "";
  const remote = /<(script|link)\b[^>]*\b(src|href)\s*=\s*["']?(https?:)?\/\//i.test(html);
  return { name: name.slice(0, 40), icon, html, remote };
}

function iconPng(src) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onerror = reject;
    im.onload = () => {
      const c = document.createElement("canvas"), g = c.getContext("2d"), n = 64;
      c.width = c.height = n;
      const k = Math.min(n / (im.naturalWidth || n), n / (im.naturalHeight || n));
      const w = (im.naturalWidth || n) * k, h = (im.naturalHeight || n) * k;
      g.drawImage(im, (n - w) / 2, (n - h) / 2, w, h);
      resolve(c.toDataURL("image/png"));
    };
    im.src = src;
  });
}

function appId() {
  const b = new Uint8Array(6); crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// Adds a new app, or with index swaps the file of an existing one in place.
async function installApp(index) {
  const file = await pickHtml();
  if (!file) return;
  const a = await readApp(file);
  const apps = S.draft.webos.apps;
  const total = apps.reduce((n, x, i) => n + (i === index ? 0 : x.html.length), 0) + a.html.length;
  if (total > APPS_TOTAL) throw new Error("That would put more than " + fmtSize(APPS_TOTAL) + " of apps in the client file.");
  if (index == null) apps.push({ id: appId(), name: a.name, icon: a.icon, html: a.html });
  else Object.assign(apps[index], { icon: a.icon, html: a.html });
  rerenderForm(); syncDraftUI();
  toast(a.remote
    ? a.name + " loads files from the internet, which installed apps can’t do. It may not work."
    : (index == null ? "Added " : "Replaced ") + a.name + (S.selected === "new" ? "" : ". Save to keep it."));
}

// Colors can't go in style attributes under this page's CSP, so the style
// thumbnails and swatches get theirs through the CSSOM after each render.
function paintOs() {
  const d = S.draft;
  if (!d || !d.webos) return;
  const accent = d.webos.accent;
  document.querySelectorAll("[data-thumb]").forEach((el) => {
    const k = el.dataset.thumb;
    el.style.setProperty("--a", k === d.webos.style ? accent : styleAccents(k)[0] || accent);
  });
  let preset = false;
  document.querySelectorAll("[data-swatch]").forEach((el) => {
    el.style.background = el.dataset.swatch;
    const on = el.dataset.swatch === accent;
    preset = preset || on;
    el.classList.toggle("on", on);
  });
  const custom = document.querySelector(".swatch.custom");
  if (custom) {
    custom.classList.toggle("on", !preset);
    custom.style.setProperty("--a", accent);
    const input = custom.querySelector("input");
    if (input.value !== accent) input.value = accent;
  }
  const hex = $("#accent-hex");
  if (hex) hex.textContent = accent;
}

// --------------------------------------------------------------- terminal
// The Web OS Terminal app signs in to this server like an ssh client: the
// token in the file gets it to the server, the password set here gets it a
// shell. The password is saved straight away (only its hash is kept), not
// with the form's Save button.
function terminalCard(s) {
  const on = !!s.terminal.hash, live = isLive(s.id);
  return '<div class="card"><h2>Terminal</h2>' +
    '<p class="lead">The desktop’s Terminal app opens a command prompt on this computer, running as you. ' +
    "People sign in to it with a password you set here; the client file alone isn’t enough.</p>" +
    '<div class="banner' + (on ? " ok" : "") + '">' + (on
      ? "On. Anyone with the client file <strong>and</strong> this password can run any command on this computer" + (s.kind === "webos" ? "" : " (once the client type above is saved as Web OS)") + "."
      : "Off. Set a password to turn it on.") +
    (live ? " Restart the server for a change here to take effect." : "") + "</div>" +
    '<div class="grid2">' +
    field(on ? "New password" : "Password", '<input type="password" id="term-pass" autocomplete="new-password" maxlength="256">', "At least 8 characters. It is never shown again.") +
    field("Confirm password", '<input type="password" id="term-pass2" autocomplete="new-password" maxlength="256">') +
    "</div>" +
    '<div class="row"><button class="btn primary" data-action="term-pass">' + (on ? "Change password" : "Set password") + "</button>" +
    (on ? '<button class="btn danger" data-action="term-off">Turn off terminal</button>' : "") + "</div>" +
    '<p class="small muted">Commands run without a full terminal: line-based tools work, full-screen ones such as vim or top don’t. ' +
    "Use TLS or a tunnel when people sign in over the internet.</p></div>";
}

// --------------------------------------------------------------- settings
function settingsForm(d) {
  return '<div class="card"><h2>General</h2>' +
    field("Name", '<input type="text" maxlength="80" data-bind="name" value="' + esc(d.name) + '">', "Only shown in this app and in the client file's name.") +
    '<div class="grid2">' +
    field("Maximum sessions", '<input type="number" min="1" max="64" data-bind="maxSessions" value="' + d.maxSessions + '">', "Browser sessions that can run at once. Each one uses memory.") +
    field("Idle timeout (minutes)", '<input type="number" min="1" max="1440" data-bind="idleMin" value="' + d.idleMin + '">', "How long a session survives with nobody watching it.") +
    "</div>" +
    field("Browser",
      '<div class="row"><input class="grow" type="text" placeholder="Found automatically" data-bind="chromePath" value="' + esc(d.chromePath) + '">' +
      '<button class="btn" data-action="pick" data-bind="chromePath">Browse</button></div>',
      "Chrome, Chromium or Edge. Leave empty to use whichever is installed.") +
    '<label class="check"><input type="checkbox" data-bind="autoStart"' + (d.autoStart ? " checked" : "") + '><span>Start this server when Plover Server opens</span></label>' +
    "</div>";
}

function dangerZone() {
  return '<div class="card"><h2>Delete server</h2><p class="lead">Stops it and removes its settings. Client files you\'ve handed out stop working.</p>' +
    '<button class="btn danger" data-action="delete">Delete this server</button></div>';
}

// ------------------------------------------------------------- create view
function createView() {
  const d = S.draft;
  return '<div class="head"><h1>New server</h1></div>' + errorsBanner() +
    '<div class="card"><h2>Name</h2>' +
    field("", '<input type="text" maxlength="80" data-bind="name" value="' + esc(d.name) + '">', "Just for you, to tell servers apart.") +
    "</div>" +
    clientForm(d) +
    networkForm(d) +
    '<div class="savebar"><button class="btn" data-action="cancel-new">Cancel</button><button class="btn primary" data-action="create">Create server</button></div>';
}

// -------------------------------------------------------------------- logs
function logsView() {
  return '<div class="row mb10"><span class="muted small grow">Output from the server, the tunnel and the relay agent.</span>' +
    '<button class="btn sm" data-action="copy-logs">Copy</button><button class="btn sm" data-action="clear-logs">Clear</button></div>' +
    '<div class="logs" id="logs">' + S.logs.map(logLine).join("") + "</div>";
}

function logLine(e) {
  const t = new Date(e.t).toLocaleTimeString([], { hour12: false });
  return '<div><span class="muted">' + t + '</span> <span class="src src-' + esc(e.src) + '">' + esc(e.src) + "</span>" + esc(e.line) + "</div>";
}

function scrollLogs(force) {
  const el = $("#logs");
  if (el && (force || el.scrollHeight - el.scrollTop - el.clientHeight < 60)) el.scrollTop = el.scrollHeight;
}

// ----------------------------------------------------------------- actions
async function refresh() {
  const res = await api.list();
  S.servers = res.servers; S.runtime = res.runtime; S.styles = res.styles || {};
}

async function select(id, tab) {
  S.selected = id; S.tab = tab || "overview"; S.errors = []; S.showToken = false; S.relayTest = null;
  const s = current();
  S.draft = s ? clone(s) : null;
  S.relayView = s && s.network.relay.url ? "have" : S.relayView;
  S.logs = s ? await api.logs(id) : [];
  render();
}

function syncDraftUI() {
  const save = $("#btn-save"), revert = $("#btn-revert"), note = $("#dirty-note");
  if (save) { const d = dirty(); save.disabled = !d; revert.disabled = !d; note.textContent = d ? "Unsaved changes" : ""; }
  const pv = $("#preview");
  if (pv && S.draft) pv.innerHTML = previewText(S.draft, previewUrl(S.draft));
  const fh = $("#forward-hint");
  if (fh && S.draft) {
    const n = S.draft.network;
    fh.hidden = n.custom.publicPort === n.streamPort;
    fh.innerHTML = "Clients use port <strong>" + n.custom.publicPort + "</strong> but the server listens on <strong>" + n.streamPort +
      "</strong>, so your router must forward external port " + n.custom.publicPort + " to this computer's port " + n.streamPort + ".";
  }
  paintOs();
}

const rerenderForm = () => (S.selected === "new" ? renderMain() : renderBody());

async function checkCloudflared() {
  S.cf = await api.cloudflaredStatus();
  if (S.draft && S.draft.network.mode === "tunnel" && (S.selected === "new" || S.tab === "network")) rerenderForm();
}

const actions = {
  async new() {
    S.selected = "new"; S.errors = []; S.relayView = "have"; S.relayTest = null;
    S.draft = await api.defaults();
    render();
    checkCloudflared();
  },
  "cancel-new"() { select(S.servers[0] ? S.servers[0].id : null); },
  async create() {
    const res = await api.create(S.draft);
    if (!res.ok) { S.errors = res.errors; renderMain(); $(".main").scrollTop = 0; return; }
    await refresh();
    await select(res.server.id);
    toast("Server created. Start it, then download the client file.");
  },
  select(el) { if (el.dataset.id !== S.selected) select(el.dataset.id); },
  tab(el) {
    S.tab = el.dataset.tab; S.errors = [];
    renderTabs(); renderBody();
    if (S.tab === "network" && S.draft.network.mode === "tunnel") checkCloudflared();
  },
  mode(el) {
    S.draft.network.mode = el.dataset.mode; S.relayTest = null;
    rerenderForm(); syncDraftUI();
    if (el.dataset.mode === "tunnel") checkCloudflared();
  },
  kind(el) { S.draft.kind = el.dataset.kind; rerenderForm(); syncDraftUI(); },
  // A new style starts on its own default accent: each palette is tuned to its look.
  "os-style"(el) {
    S.draft.webos.style = el.dataset.style;
    S.draft.webos.accent = styleAccents(el.dataset.style)[0] || S.draft.webos.accent;
    rerenderForm(); syncDraftUI();
  },
  "os-accent"(el) { S.draft.webos.accent = el.dataset.value; syncDraftUI(); },
  "wp-import"() {
    const input = document.createElement("input");
    input.type = "file"; input.accept = "image/*";
    input.addEventListener("change", async () => {
      const f = input.files[0];
      if (!f) return;
      try { S.draft.webos.wallpaper = await encodePicture(f); }
      catch (err) { toast(cleanErr(err)); return; }
      rerenderForm(); syncDraftUI();
    });
    input.click();
  },
  "wp-clear"() { S.draft.webos.wallpaper = ""; rerenderForm(); syncDraftUI(); },
  "app-add"() { return installApp(null); },
  "app-replace"(el) { return installApp(Number(el.dataset.index)); },
  "app-remove"(el) {
    const a = S.draft.webos.apps[Number(el.dataset.index)];
    if (!a || !confirm("Remove “" + a.name + "” from the desktop? Client files you download from now on won't have it.")) return;
    S.draft.webos.apps.splice(Number(el.dataset.index), 1);
    rerenderForm(); syncDraftUI();
  },
  "relay-view"(el) { S.relayView = el.dataset.view; rerenderForm(); },
  "gen-secret"() { S.draft.network.relay.secret = secret(); rerenderForm(); syncDraftUI(); },
  async "test-relay"() {
    const url = S.draft.network.relay.url;
    if (!/^wss?:\/\/[^/\s]+$/i.test(url)) { S.relayTest = { ok: false, msg: "Enter an address like wss://relay.example.com first." }; }
    else { S.relayTest = "busy"; $("#relay-test").innerHTML = relayTestText(); S.relayTest = await api.testRelay(url); }
    const el = $("#relay-test"); if (el) el.innerHTML = relayTestText();
  },
  async "export-relay"() {
    const dest = await api.exportRelay();
    if (dest) toast("Relay files exported to " + dest);
  },
  async "install-cf"() {
    S.cfProgress = { got: 0, total: 0 }; rerenderForm();
    try { await api.installCloudflared(); toast("cloudflared installed"); }
    catch (e) { toast("Could not install cloudflared: " + cleanErr(e)); }
    S.cfProgress = null;
    await checkCloudflared(); rerenderForm();
  },
  async pick(el) {
    const f = await api.pickFile(el.dataset.bind === "chromePath" ? "Choose Chrome, Chromium or Edge" : "Choose a PEM file");
    if (!f) return;
    setPath(S.draft, el.dataset.bind, f);
    const input = el.parentElement.querySelector("input");
    if (input) input.value = f;
    syncDraftUI();
  },
  async save() {
    const res = await api.update(S.selected, S.draft);
    if (!res.ok) { S.errors = res.errors; renderBody(); $(".main").scrollTop = 0; return; }
    S.errors = [];
    const i = S.servers.findIndex((s) => s.id === S.selected);
    S.servers[i] = res.server; S.draft = clone(res.server);
    render();
    toast(isLive(S.selected) ? "Saved. Restart the server to apply." : "Saved");
  },
  revert() { S.draft = clone(current()); S.errors = []; renderBody(); },
  async start() {
    if (dirty() && !confirm("You have unsaved changes. Start with the last saved settings?")) return;
    S.runtime[S.selected] = await api.start(S.selected); render();
  },
  async stop() { S.runtime[S.selected] = await api.stop(S.selected); render(); },
  async restart() { S.runtime[S.selected] = await api.restart(S.selected); render(); },
  async download() {
    try {
      const f = await api.downloadHtml(S.selected);
      if (f) toast("Saved " + f);
    } catch (e) { toast(cleanErr(e)); }
  },
  async copy(el) { await api.copy(el.dataset.value); toast("Copied"); },
  "toggle-token"() { S.showToken = !S.showToken; renderBody(); },
  async regen() {
    if (!confirm("Regenerate the access token? Every client file handed out so far stops working." + (isLive(S.selected) ? " The running server keeps the old token until you restart it." : ""))) return;
    const t = await api.regenerateToken(S.selected);
    current().token = t; S.draft.token = t;
    renderBody(); toast("New token created. Download the client file again.");
  },
  async "term-pass"() {
    const a = $("#term-pass").value, b = $("#term-pass2").value;
    if (a.length < 8) { toast("Use at least 8 characters."); $("#term-pass").focus(); return; }
    if (a !== b) { toast("The passwords don't match."); $("#term-pass2").focus(); return; }
    await setTerminal(a, isLive(S.selected) ? "Terminal password saved. Restart the server to use it." : "Terminal password saved");
  },
  async "term-off"() {
    if (!confirm("Turn off the terminal? Nobody can sign in to it until you set a password again." + (isLive(S.selected) ? " Terminals open now stay open until you restart the server." : ""))) return;
    await setTerminal("", isLive(S.selected) ? "Terminal turned off. Restart the server to apply." : "Terminal turned off");
  },
  "open-page"(el) { api.openExternal(el.dataset.value); },
  ext(el) { api.openExternal(el.dataset.value); },
  async delete() {
    const s = current();
    if (!confirm("Delete “" + s.name + "”? This can't be undone.")) return;
    await api.remove(s.id);
    await refresh();
    select(S.servers[0] ? S.servers[0].id : null);
  },
  async "copy-logs"() { await api.copy(S.logs.map((e) => e.src + " " + e.line).join("\n")); toast("Logs copied"); },
  async "clear-logs"() { await api.clearLogs(S.selected); S.logs = []; renderBody(); },
};

// Saved on its own, so the form's unsaved edits stay as they are.
async function setTerminal(password, done) {
  const res = await api.setTerminalPassword(S.selected, password);
  if (!res.ok) { toast(res.errors.join(" ")); return; }
  current().terminal = res.server.terminal; S.draft.terminal = clone(res.server.terminal);
  renderBody(); toast(done);
}

const cleanErr = (e) => String(e && e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  e.preventDefault();
  const fn = actions[el.dataset.action];
  if (fn) Promise.resolve(fn(el)).catch((err) => toast(cleanErr(err)));
});

function onField(e) {
  const el = e.target;
  if (!el.matches("input[data-bind], select[data-bind]") || !S.draft) return;
  const v = el.type === "checkbox" ? el.checked : el.type === "number" ? (el.value === "" ? "" : Number(el.value)) : el.value;
  setPath(S.draft, el.dataset.bind, v);
  if (e.type === "change" && el.hasAttribute("data-rerender")) rerenderForm();
  syncDraftUI();
}
document.addEventListener("input", onField);
document.addEventListener("change", onField);

// ------------------------------------------------------------------ events
api.on("runtime", (snap) => {
  const wasLive = isLive(snap.id);
  S.runtime[snap.id] = snap;
  renderSidebar();
  if (snap.id !== S.selected) return;
  renderHead();
  if (S.tab === "overview") renderBody();
  // The forms only show whether the server is running ("restart to apply").
  else if (S.tab !== "logs" && wasLive !== isLive(snap.id) && !document.activeElement.matches("input")) renderBody();
});

api.on("log", ({ id, entry }) => {
  if (id !== S.selected) return;
  S.logs.push(entry);
  if (S.logs.length > 3000) S.logs.shift();
  const el = $("#logs");
  if (el) { el.insertAdjacentHTML("beforeend", logLine(entry)); scrollLogs(false); }
});

api.on("cloudflared-progress", (p) => {
  S.cfProgress = p;
  const bar = $(".progress > div");
  if (bar && p.total) bar.style.width = Math.round(p.got / p.total * 100) + "%";
});

(async () => {
  await refresh();
  if (S.servers.length) await select(S.servers[0].id);
  else render();
})();
