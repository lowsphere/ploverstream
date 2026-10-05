"use strict";
// One viewer session: a browser context, its tabs, the screencast of the
// active tab, and the viewer's input. Connections attach and detach; the
// session and its tabs outlive a dropped connection for idleMs, so a reconnect
// carrying the session id lands back where it was.

const { keyEvent } = require("./keys");
const { Inspector } = require("./inspector");
const { BINDING: AUDIO_BINDING, installAudio, parsePost } = require("./audio");

const FRAME_WINDOW = 2;              // JPEG frames sent but not yet reported drawn ("fa")
const ACK_TIMEOUT_MS = 1000;         // the viewer drops undecodable frames without acking them
const MAX_BUFFERED = 4 * 1024 * 1024;
const AUDIO_MAX_BUFFERED = 2 * MAX_BUFFERED;   // past this audio is dropped; late audio is useless
const AUDIO_POSTS_PER_SEC = 400;     // a playing tap posts ~24/s; more is a page misusing the binding
const noop = () => {};

const BUTTONS = ["left", "middle", "right", "back", "forward"];
function heldButton(bs) {
  return bs & 1 ? "left" : bs & 4 ? "middle" : bs & 2 ? "right" : bs & 8 ? "back" : bs & 16 ? "forward" : "none";
}
function clamp(v, lo, hi, d) { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; }

// Decoded byte length of a base64 string (no embedded newlines, as CDP sends).
// Lets us size the frame buffer without first decoding to a throwaway Buffer.
function b64ByteLength(s) {
  const n = s.length;
  if (n === 0) return 0;
  let pad = 0;
  if (s.charCodeAt(n - 1) === 61) pad++;
  if (s.charCodeAt(n - 2) === 61) pad++;
  return ((n * 3) >> 2) - pad;
}

// Viewers may open the web, not the server's filesystem or browser internals.
function safeUrl(u) {
  u = String(u || "").trim();
  if (u === "about:blank" || u === "about:newtab") return "about:blank";
  try { const x = new URL(u); if (x.protocol === "http:" || x.protocol === "https:") return x.href; } catch (_) {}
  return null;
}
function originOf(u) { try { return new URL(u).origin; } catch (_) { return ""; } }

// Run in the page. CDP has no cursor-change event, so resolve what Chrome
// would show: the computed cursor, or for "auto" an I-beam over text.
function cursorAt(x, y) {
  var e = document.elementFromPoint(x, y);
  if (!e) return "default";
  var c = getComputedStyle(e).cursor;
  if (c && c !== "auto") return c;
  if (e.isContentEditable || e.tagName === "TEXTAREA") return "text";
  if (e.tagName === "INPUT" && /^(text|search|email|url|tel|password|number)$/.test(e.type)) return "text";
  var r = document.caretRangeFromPoint && document.caretRangeFromPoint(x, y);
  if (r && r.startContainer.nodeType === 3) {
    var t = document.createRange(); t.selectNodeContents(r.startContainer);
    var rs = t.getClientRects();
    for (var i = 0; i < rs.length; i++) {
      var b = rs[i]; if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) return "text";
    }
  }
  return "default";
}
function faviconHref() {
  var links = document.querySelectorAll('link[rel~="icon" i]');
  for (var i = 0; i < links.length; i++) if (links[i].href) return links[i].href;
  return location.origin + "/favicon.ico";
}

class Session {
  constructor(hub, { id, idleMs, log, onClose }) {
    Object.assign(this, { hub, id, idleMs, log, onClose });
    this.createdAt = Date.now();
    this.client = {}; this.ip = ""; this.transport = "wan";
    this.ctx = null;
    this.tabs = new Map(); this.order = []; this.byPage = new Map();
    this.active = null; this.tabSeq = 0;
    this.conn = null; this.connectedAt = 0; this.idleTimer = null;
    this.view = { w: 1280, h: 800, dpr: 1 };
    this.q = { jpeg: 70, fps: 60 };
    this.dialogs = new Map(); this.dialogSeq = 0;
    this.castChain = Promise.resolve(); this.castTab = null; this.castKey = ""; this.castFrames = 0;
    this.seq = 0; this.acked = 0; this.lastSentAt = 0; this.pending = null; this.pumpTimer = null;
    this.cursor = { at: null, timer: null, busy: false, last: "" };
    this.tabsTimer = null; this.qTimer = null;
    // Off until the viewer asks: a client that predates audio never gets it.
    this.audio = { on: false, ids: new Map(), next: 0, posts: 0, window: 0 };
    this.insp = new Inspector(this);
    this.closed = false;
  }

  async init() {
    this.ctx = await this.hub.newContext();
    // Pages the site opens itself (window.open, target=_blank) become tabs too.
    this.ctx.on("targetcreated", (target) => {
      if (target.type() !== "page") return;
      target.page().then((page) => page && this._adopt(page)).catch(noop);
    });
    await this._adopt(await this.ctx.newPage());
  }

  // ---------------------------------------------------------------- lifecycle
  attach(conn) {
    if (this.closed) return;
    const prev = this.conn;
    if (prev && prev !== conn) { prev.session = null; prev.close(4409, "open elsewhere"); }
    clearTimeout(this.idleTimer); this.idleTimer = null;
    this.conn = conn; conn.session = this;
    this.client = conn.client; this.ip = conn.ip; this.transport = conn.transport;
    this.connectedAt = Date.now();
    if (!conn.open()) { this.detach(conn); return; }     // it went away while we were starting
    this._resetFlow();
    this.cursor.last = "";
    conn.send({ t: "hello", session: this.id, tabs: this._tabList(), active: this.active, transport: this.transport });
    for (const [id, d] of this.dialogs) conn.send({ t: "dialog", id, kind: d.kind, msg: d.msg, default: d.def });
    this._recast(true);
  }

  detach(conn) {
    if (this.conn !== conn) return;
    this.conn = null; conn.session = null;
    this._resetFlow();
    this.insp.handle(null, { t: "insp.close" });            // nobody is watching the highlight
    this._recast();                                         // stops the screencast
    if (!this.closed) this.idleTimer = setTimeout(() => this.destroy("idle"), this.idleMs);
  }

  async destroy(reason, code) {
    if (this.closed) return;
    this.closed = true;
    for (const t of [this.idleTimer, this.pumpTimer, this.tabsTimer, this.qTimer, this.cursor.timer]) clearTimeout(t);
    const conn = this.conn; this.conn = null;
    if (conn) { conn.session = null; conn.close(code || 1011, reason); }
    for (const tab of this.tabs.values()) this.hub.targets.delete(tab.targetId);
    this.dialogs.clear();
    this.onClose(this, reason);
    if (this.ctx) await this.ctx.close().catch(noop);
  }

  summary() {
    const tab = this.tabs.get(this.active);
    return {
      id: this.id, device: this.client.device || "Unknown device", transport: this.transport, ip: this.ip,
      connectedAt: this.connectedAt || this.createdAt, status: this.conn ? "connected" : "idle",
      codec: "jpeg", title: tab ? tab.title : "", url: tab ? tab.url : "",
    };
  }

  // ------------------------------------------------------------------ control
  handle(m) {
    const tab = this.tabs.get(this.active);
    switch (m.t) {
      case "ping": this._send({ t: "pong", ts: m.ts }); break;
      case "view": this._setView(m); break;
      case "q": this._setQuality(m); break;
      // No H.264 encoder here: frames are Chromium's own JPEG screencast.
      case "codec": this._send({ t: "codec", codec: "jpeg" }); break;
      case "audio": this.audio.on = !!m.on; break;
      case "fa": { const s = m.seq >>> 0; if (s > this.acked && s <= this.seq) { this.acked = s; this._pump(); } break; }
      case "nav": this._navigate(tab, m.url); break;
      case "back": this._history(tab, -1); break;
      case "fwd": this._history(tab, 1); break;
      case "reload": if (tab) this._cdp(tab, "Page.reload", {}); break;
      case "tab.new": this._newTab(); break;
      case "tab.close": { const t = this.tabs.get(m.id); if (t) t.page.close({ runBeforeUnload: false }).catch(noop); break; }
      case "tab.switch": if (this.tabs.has(m.id)) this._activate(m.id); break;
      case "m": this._mouse(tab, m); break;
      case "w":
        if (tab) this._cdp(tab, "Input.dispatchMouseEvent", {
          type: "mouseWheel", x: clamp(m.x, 0, 1e4, 0), y: clamp(m.y, 0, 1e4, 0),
          deltaX: clamp(m.dx, -1e5, 1e5, 0), deltaY: clamp(m.dy, -1e5, 1e5, 0), modifiers: (m.mods | 0) & 15,
        });
        break;
      case "k": if (tab) this._cdp(tab, "Input.dispatchKeyEvent", keyEvent(m)); break;
      case "txt": if (tab && m.s) this._cdp(tab, "Input.insertText", { text: String(m.s).slice(0, 100000) }); break;
      case "dialog": this._answerDialog(m); break;
      case "diag": this.log("client " + this.id.slice(0, 8) + " diag " + String(m.kind).slice(0, 40) + ": " + String(m.message || "").slice(0, 300)); break;
      default: if (typeof m.t === "string" && m.t.startsWith("insp.")) this.insp.handle(tab, m);
      // kf, rtc.*: this backend streams JPEG over the socket only and never offers WebRTC.
    }
  }

  _send(obj) { if (this.conn) this.conn.send(obj); }
  _cdp(tab, method, params) { if (tab && tab.cdp) tab.cdp.send(method, params).catch(noop); }

  _setView(m) {
    this.view = {
      w: Math.round(clamp(m.w, 200, 7680, 1280)),
      h: Math.round(clamp(m.h, 150, 4320, 800)),
      dpr: clamp(m.dpr, 0.5, 3, 1),
    };
    this._recast();
  }

  _setQuality(m) {
    const jpeg = Math.round(clamp(m.jpeg, 10, 100, this.q.jpeg));
    const fps = clamp(m.fps, 1, 60, this.q.fps);
    const changed = jpeg !== this.q.jpeg;
    this.q = { jpeg, fps };
    // The quality slider sends on every step; restart the screencast once it settles.
    if (changed) { clearTimeout(this.qTimer); this.qTimer = setTimeout(() => this._recast(), 200); }
    this._pump();
  }

  _navigate(tab, raw) {
    const url = safeUrl(raw);
    if (!url) { this._send({ t: "err", code: "nav_blocked", msg: "Only http:// and https:// addresses can be opened." }); return; }
    this._cdp(tab, "Page.navigate", { url });
  }

  async _history(tab, delta) {
    if (!tab) return;
    try {
      const h = await tab.cdp.send("Page.getNavigationHistory");
      const e = h.entries[h.currentIndex + delta];
      if (e) await tab.cdp.send("Page.navigateToHistoryEntry", { entryId: e.id });
    } catch (_) {}
  }

  _mouse(tab, m) {
    const type = { down: "mousePressed", up: "mouseReleased", move: "mouseMoved" }[m.k];
    if (!tab || !type) return;
    const x = clamp(m.x, 0, 1e4, 0), y = clamp(m.y, 0, 1e4, 0), bs = (m.bs | 0) & 31;
    this._cdp(tab, "Input.dispatchMouseEvent", {
      type, x, y, modifiers: (m.mods | 0) & 15, buttons: bs,
      button: m.k === "move" ? heldButton(bs) : BUTTONS[m.b] || "none",
      clickCount: m.k === "move" ? 0 : Math.round(clamp(m.n, 1, 10, 1)),
    });
    if (m.k !== "down") this._probeCursor(tab, x, y);
  }

  // At most one lookup in flight; the newest position wins.
  _probeCursor(tab, x, y) {
    const c = this.cursor;
    c.at = { tab, x, y };
    if (c.timer || c.busy) return;
    c.timer = setTimeout(async () => {
      c.timer = null;
      const at = c.at;
      if (!at || at.tab.id !== this.active || !this.conn) return;
      c.busy = true;
      try {
        const r = await at.tab.cdp.send("Runtime.evaluate", { expression: "(" + cursorAt + ")(" + at.x + "," + at.y + ")", returnByValue: true });
        const v = r && r.result && typeof r.result.value === "string" ? r.result.value.slice(0, 300) : "default";
        if (v !== c.last) { c.last = v; this._send({ t: "cursor", c: v }); }
      } catch (_) {}
      c.busy = false;
      if (c.at !== at) this._probeCursor(c.at.tab, c.at.x, c.at.y);
    }, 50);
  }

  // --------------------------------------------------------------- dialogs
  _onDialog(tab, d) {
    const id = ++this.dialogSeq;
    const rec = { tab, d, kind: d.type(), msg: String(d.message() || "").slice(0, 4000), def: d.defaultValue() || "" };
    this.dialogs.set(id, rec);
    if (tab.id !== this.active) this._activate(tab.id);    // the client has one modal, so show the tab it belongs to
    this._send({ t: "dialog", id, kind: rec.kind, msg: rec.msg, default: rec.def });
  }

  _answerDialog(m) {
    const rec = this.dialogs.get(m.id);
    if (!rec) return;
    this.dialogs.delete(m.id);
    const text = typeof m.text === "string" ? m.text.slice(0, 10000) : undefined;
    (m.accept ? rec.d.accept(text) : rec.d.dismiss()).catch(noop);
  }

  // ------------------------------------------------------------------ tabs
  _newTab() {
    if (this.closed) return;
    this.ctx.newPage().then((p) => this._adopt(p)).catch((e) => this.log("new tab: " + e.message));
  }

  // Both ctx.newPage() and the targetcreated event land here; the first wins.
  _adopt(page) {
    const known = this.byPage.get(page);
    if (known) return known.ready;
    if (this.closed) return page.close().catch(noop);
    const tab = {
      id: ++this.tabSeq, session: this, page, cdp: null, targetId: null,
      url: page.url() || "about:blank", title: "", loading: false, favicon: "", viewKey: "", ready: null,
    };
    this.byPage.set(page, tab); this.tabs.set(tab.id, tab); this.order.push(tab.id);
    this._tabsChanged();
    tab.ready = this._wire(tab).then(
      () => { if (this.tabs.has(tab.id)) this._activate(tab.id); },
      (e) => { if (this.tabs.has(tab.id)) { this.log("tab setup: " + e.message); page.close().catch(noop); } },
    );
    return tab.ready;
  }

  async _wire(tab) {
    const { page } = tab;
    page.on("close", () => this._onClosed(tab));
    page.on("dialog", (d) => this._onDialog(tab, d));
    page.on("error", () => {
      if (tab.id === this.active) this._send({ t: "err", code: "tab_crashed", msg: "This tab crashed. Reload to try again." });
    });
    const cdp = tab.cdp = await page.createCDPSession();
    const { targetInfo } = await cdp.send("Target.getTargetInfo");
    tab.targetId = targetInfo.targetId;            // also the id of the tab's main frame
    this.hub.targets.set(tab.targetId, tab);
    this._targetInfo(tab, targetInfo);
    this.insp.watch(tab);
    cdp.on("Page.screencastFrame", ({ data, sessionId }) => {
      cdp.send("Page.screencastFrameAck", { sessionId }).catch(noop);
      if (tab.id !== this.active || !this.conn) return;
      this.castFrames++;
      this.pending = data;   // raw base64; newest wins, decoded only if it survives to _pump
      this._pump();
    });
    cdp.on("Page.frameStartedLoading", ({ frameId }) => { if (frameId === tab.targetId) this._setLoading(tab, true); });
    cdp.on("Page.frameStoppedLoading", ({ frameId }) => {
      if (frameId !== tab.targetId) return;
      this._setLoading(tab, false);
      this._readTitle(tab);
      this._favicon(tab);
    });
    cdp.on("Page.domContentEventFired", () => this._readTitle(tab));
    cdp.on("Runtime.bindingCalled", ({ name, payload, executionContextId }) => {
      if (name === AUDIO_BINDING) this._audio(tab, executionContextId, payload);
    });
    // Never let a page open a native file picker on the server.
    cdp.on("Page.fileChooserOpened", () => this._send({ t: "err", code: "file_chooser", msg: "Uploading files isn't supported." }));
    await Promise.all([
      cdp.send("Page.enable"),
      cdp.send("Page.setInterceptFileChooserDialog", { enabled: true }),
      cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }),
      cdp.send("Emulation.setUserAgentOverride", { userAgent: this.hub.userAgent }),
      this._applyView(tab),
      installAudio(cdp).catch((e) => this.log("tab audio: " + e.message)),
    ]);
  }

  _onClosed(tab) {
    if (!this.tabs.has(tab.id)) return;
    this.tabs.delete(tab.id); this.byPage.delete(tab.page); this.hub.targets.delete(tab.targetId);
    const i = this.order.indexOf(tab.id);
    this.order.splice(i, 1);
    for (const [id, d] of this.dialogs) if (d.tab === tab) this.dialogs.delete(id);
    for (const key of this.audio.ids.keys()) if (key.startsWith(tab.id + ":")) this.audio.ids.delete(key);
    if (this.castTab === tab) { this.castTab = null; this.castKey = ""; }
    this.insp.forget(tab);
    if (this.closed) return;
    if (this.active === tab.id) {
      this.active = null;
      const next = this.order[Math.min(i, this.order.length - 1)];
      if (next !== undefined) this._activate(next);
    }
    if (!this.order.length) this._newTab();      // like Chrome, never zero tabs
    this._tabsChanged();
  }

  _activate(id) {
    const tab = this.tabs.get(id);
    if (!tab || !tab.cdp) return;              // still wiring; _adopt activates it when ready
    if (this.active !== id) { this.active = id; this.pending = null; this.cursor.last = ""; }
    this.insp.follow(tab);
    this._tabsChanged();
    this._recast();
  }

  // Called for Target.targetInfoChanged, which covers title changes and
  // same-document navigations as well as ordinary ones.
  _targetInfo(tab, info) {
    const url = info.url || "about:blank";
    if (originOf(url) !== originOf(tab.url)) tab.favicon = "";
    tab.url = url;
    tab.title = String(info.title || "").slice(0, 500);
    this._tabsChanged();
  }

  // targetInfoChanged reports titles set by script, but not one that arrives
  // with the page's own <title>, so read it once the document is parsed.
  async _readTitle(tab) {
    try {
      const r = await tab.cdp.send("Runtime.evaluate", { expression: "document.title", returnByValue: true });
      const title = r && r.result && typeof r.result.value === "string" ? r.result.value.slice(0, 500) : "";
      if (title && title !== tab.title) { tab.title = title; this._tabsChanged(); }
    } catch (_) {}
  }

  _setLoading(tab, v) { if (tab.loading !== v) { tab.loading = v; this._tabsChanged(); } }

  async _favicon(tab) {
    let icon = "";
    if (/^https?:/.test(tab.url)) {
      try {
        const r = await tab.cdp.send("Runtime.evaluate", { expression: "(" + faviconHref + ")()", returnByValue: true });
        icon = await this.hub.favicon(r && r.result && typeof r.result.value === "string" ? r.result.value : "");
      } catch (_) { return; }
    }
    if (icon !== tab.favicon) { tab.favicon = icon; this._tabsChanged(); }
  }

  _tabList() {
    return this.order.map((id) => {
      const t = this.tabs.get(id);
      return { id, title: t.title, url: t.url, loading: t.loading, favicon: t.favicon || undefined };
    });
  }

  _tabsChanged() {
    if (this.tabsTimer || this.closed) return;
    this.tabsTimer = setTimeout(() => {
      this.tabsTimer = null;
      this._send({ t: "tabs", tabs: this._tabList(), active: this.active });
    }, 30);
  }

  // ----------------------------------------------------------------- audio
  // Every tab is heard, not just the one on screen, as in a desktop browser.
  // Each tap (one per AudioContext, and one for a document's media elements)
  // becomes its own source, which the client schedules and Web Audio mixes.
  _audio(tab, ctxId, payload) {
    const a = this.audio, conn = this.conn;
    if (!a.on || !conn || this.closed) return;
    const now = Date.now();
    if (now - a.window >= 1000) { a.window = now; a.posts = 0; }
    if (++a.posts > AUDIO_POSTS_PER_SEC) return;
    const post = parsePost(payload);
    if (!post || conn.buffered() > AUDIO_MAX_BUFFERED) return;
    const key = tab.id + ":" + ctxId + ":" + post.tap;
    let id = a.ids.get(key);
    if (id === undefined) {
      if (a.ids.size >= 256) a.ids.clear();
      id = a.next = (a.next + 1) & 0xffff;
      a.ids.set(key, id);
    }
    const msg = Buffer.allocUnsafe(8 + post.pcm.length);
    msg[0] = 0x03; msg.writeUInt16BE(id, 1); msg.writeUInt32BE(post.rate, 3); msg[7] = 2;
    post.pcm.copy(msg, 8);
    conn.sendRaw(msg);
  }

  // ---------------------------------------------------------------- frames
  async _applyView(tab) {
    const v = this.view, key = v.w + "x" + v.h + "@" + v.dpr;
    if (tab.viewKey === key) return;
    tab.viewKey = key;
    try {
      await tab.cdp.send("Emulation.setDeviceMetricsOverride", {
        width: v.w, height: v.h, deviceScaleFactor: v.dpr, mobile: false, screenWidth: v.w, screenHeight: v.h,
      });
    } catch (e) { tab.viewKey = ""; throw e; }
  }

  // Screencast changes run one at a time: start, stop and resize race otherwise.
  _queue(fn) {
    this.castChain = this.castChain.then(fn).catch((e) => { if (!this.closed) this.log("screencast: " + e.message); });
  }

  // Make the screencast match the current state: the active tab while a viewer
  // is attached, nothing otherwise. `force` restarts it so a new viewer gets a
  // first frame even from a page that is not repainting.
  _recast(force) {
    this._queue(async () => {
      const tab = this.tabs.get(this.active);
      const want = tab && tab.cdp && this.conn && !this.closed ? tab : null;
      const prev = this.castTab;
      if (prev && prev !== want) {
        this.castTab = null; this.castKey = "";
        await prev.cdp.send("Page.stopScreencast").catch(noop);
      }
      if (!want) return;
      if (prev !== want) await want.page.bringToFront().catch(noop);
      await this._applyView(want);
      const maxWidth = Math.round(this.view.w * this.view.dpr), maxHeight = Math.round(this.view.h * this.view.dpr);
      const key = maxWidth + "x" + maxHeight + "q" + this.q.jpeg;
      if (!force && this.castTab === want && this.castKey === key) return;
      if (this.castTab === want) await want.cdp.send("Page.stopScreencast").catch(noop);
      this.castTab = null;
      try {
        await want.cdp.send("Page.startScreencast", { format: "jpeg", quality: this.q.jpeg, maxWidth, maxHeight, everyNthFrame: 1 });
      } catch (e) {
        // Chrome refuses while a tab is mid-swap between renderer processes.
        if (!want.retried && this.tabs.has(want.id)) { want.retried = true; setTimeout(() => this._recast(), 250); }
        throw new Error("tab " + want.id + ": " + e.message);
      }
      want.retried = false;
      this.castTab = want; this.castKey = key;
      this._ensureFrame(want);
    });
  }

  // A restarted screencast only emits once the page repaints, so a still page
  // would leave the viewer showing the old size (or nothing, for a new
  // viewer). If no frame follows the start promptly, send a screenshot.
  _ensureFrame(tab) {
    const mark = this.castFrames;
    setTimeout(async () => {
      if (this.castTab !== tab || this.castFrames !== mark || !this.conn) return;
      try {
        const { data } = await tab.cdp.send("Page.captureScreenshot", { format: "jpeg", quality: this.q.jpeg });
        if (this.castTab !== tab || this.castFrames !== mark || !this.conn) return;
        this.pending = data;   // raw base64, like a screencast frame
        this._pump();
      } catch (_) {}
    }, 300);
  }

  _resetFlow() {
    clearTimeout(this.pumpTimer); this.pumpTimer = null;
    this.seq = 0; this.acked = 0; this.lastSentAt = 0; this.pending = null;
  }

  // Send the newest pending frame once the viewer has room for it, the socket
  // is not backed up, and the frame-rate cap allows. Chrome's frames are acked
  // on arrival, so a slow viewer skips frames instead of queueing stale ones.
  _pump() {
    clearTimeout(this.pumpTimer); this.pumpTimer = null;
    const conn = this.conn;
    if (!this.pending || !conn) return;
    const now = Date.now();
    let wait = 0;
    if (this.seq - this.acked >= FRAME_WINDOW) {
      const since = now - this.lastSentAt;
      if (since < ACK_TIMEOUT_MS) wait = ACK_TIMEOUT_MS - since;   // an "fa" normally arrives first
      else this.acked = this.seq;
    }
    if (!wait && conn.buffered() > MAX_BUFFERED) wait = 15;
    if (!wait) wait = this.lastSentAt + 1000 / this.q.fps - now;
    if (wait > 0) { this.pumpTimer = setTimeout(() => this._pump(), Math.ceil(wait)); return; }
    const b64 = this.pending; this.pending = null;
    this.seq = (this.seq + 1) >>> 0;
    // Decode straight into the framed buffer: one allocation, one decode, and
    // only for the frame that actually goes out (dropped frames stayed strings).
    const frame = Buffer.allocUnsafe(5 + b64ByteLength(b64));
    frame[0] = 0x01; frame.writeUInt32BE(this.seq, 1); frame.write(b64, 5, "base64");
    this.lastSentAt = now;
    conn.sendRaw(frame);
  }
}

module.exports = { Session, safeUrl };
