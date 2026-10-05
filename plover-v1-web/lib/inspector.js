"use strict";
// Element inspector for a session's active tab, over CDP's DOM, CSS and Overlay
// domains. Nodes are named by backendNodeId: it is stable for the life of the
// node and needs no DOM-agent bookkeeping, so the client can hold on to ids
// across requests. Highlights are drawn by Chrome's own overlay, which the
// screencast captures, so the viewer sees them in the stream.
//
// CLIENT -> SERVER
//   insp.open             start inspecting the active tab; replies insp.root
//   insp.close            stop, clear highlight and pick mode
//   insp.kids  {id}       children of a node              -> insp.kids {id, kids} | {id, gone}
//   insp.hl    {id|null}  highlight a node, or clear it
//   insp.pick  {on}       pick mode: the next click in the page selects -> insp.reveal
//   insp.sel   {id}       details of a node, scrolled into view -> insp.info
//   insp.html  {id}       outerHTML                       -> insp.html {id, html}
//   insp.set   {id, html} replace outerHTML               -> insp.done {id}
//   insp.del   {id}       remove the node                 -> insp.done {id}
//   insp.eval  {seq, src} run JavaScript in the page       -> insp.evr {seq, l, s}
//   insp.conclear         empty the tab's console
// SERVER -> CLIENT also: insp.pick {on} when Chrome leaves pick mode itself,
//   insp.root again after the document is replaced, insp.err {msg},
//   insp.con {items, reset?}: console output; reset replaces what the client
//   holds (sent on open, on a tab switch, and when the page navigates).
//
// A node on the wire: {id, t: nodeType, n: name, a?: [name, value, ...],
//   v?: text, c: child count, k?: [child nodes]}.
// A console item: {l: "log"|"info"|"warn"|"error"|"debug", s: text, src?: "file.js:12"}.
// Console output is kept per tab from the moment the tab opens, whether or not
// anyone is inspecting, so opening the console shows what already happened.

const noop = () => {};
const HIGHLIGHT = {
  showInfo: true, showStyles: true, showAccessibilityInfo: false, showExtensionLines: false,
  contentColor: { r: 45, g: 212, b: 191, a: 0.28 },
  paddingColor: { r: 56, g: 189, b: 248, a: 0.22 },
  borderColor: { r: 250, g: 204, b: 21, a: 0.35 },
  marginColor: { r: 249, g: 115, b: 22, a: 0.22 },
};
const MAX_TEXT = 300, MAX_HTML = 512 * 1024, MAX_KIDS = 2000;
const CON_KEEP = 500, CON_TEXT = 4000, CON_BURST = 300, MAX_EVAL = 100000;
const CON_LEVEL = { warning: "warn", error: "error", assert: "error", debug: "debug", verbose: "debug", info: "info" };

// RemoteObject -> one line of text, the way DevTools prints a collapsed value.
// `bare` prints strings unquoted, as console.log does its own arguments.
function show(o, bare) {
  if (!o) return "undefined";
  switch (o.type) {
    case "undefined": return "undefined";
    case "string": return bare ? String(o.value) : JSON.stringify(o.value);
    case "number": case "boolean": case "bigint": return o.unserializableValue || String(o.value);
    case "symbol": return o.description || "Symbol()";
    case "function": return "ƒ " + String(o.description || "").split("\n")[0].replace(/^(async\s+)?function\s*/, "$1").slice(0, 200);
  }
  if (o.subtype === "null") return "null";
  if (o.subtype === "error") return String(o.description || "Error");
  const p = o.preview;
  if (!p || o.subtype === "node" || o.subtype === "regexp" || o.subtype === "date") return String(o.description || o.className || "Object");
  // Property previews carry primitives in value; Map/Set entry previews only in description.
  const val = (v) => v.type === "function" ? "ƒ" : v.type === "string" ? JSON.stringify(v.value !== undefined ? v.value : v.description) : v.value !== undefined ? v.value : (v.description || v.type);
  const more = p.overflow ? ", …" : "";
  if (p.entries) {
    const items = p.entries.map((e) => (e.key ? val(e.key) + " => " : "") + val(e.value));
    return (o.description || p.description) + " {" + items.join(", ") + more + "}";
  }
  if (p.subtype === "array" || p.subtype === "typedarray") {
    const items = []; let next = 0;
    for (const q of p.properties) {
      if (/^\d+$/.test(q.name)) { if (+q.name > next) items.push("empty × " + (q.name - next)); items.push(val(q)); next = +q.name + 1; }
      else items.push(q.name + ": " + val(q));
    }
    return (o.description || "Array") + " [" + items.join(", ") + more + "]";
  }
  const items = p.properties.map((q) => (/^[A-Za-z_$][\w$]*$/.test(q.name) ? q.name : JSON.stringify(q.name)) + ": " + val(q));
  const head = o.className && o.className !== "Object" ? (o.description || o.className) + " " : "";
  return head + "{" + items.join(", ") + more + "}";
}

// console.log's own formatting: %s %d %i %f %o %O %c in a leading string.
function showArgs(args) {
  args = args || [];
  const out = [];
  let i = 0;
  if (args[0] && args[0].type === "string" && /%[sdifoOc%]/.test(args[0].value)) {
    i = 1;
    out.push(String(args[0].value).replace(/%([sdifoOc%])/g, (m, f) => {
      if (f === "%") return "%";
      if (i >= args.length) return m;
      const a = args[i++];
      if (f === "c") return "";
      if (f === "d" || f === "i") return a.type === "number" ? String(Math.trunc(a.value)) : "NaN";
      if (f === "f") return a.type === "number" ? String(a.value) : "NaN";
      return show(a, f === "s");
    }));
  }
  for (; i < args.length; i++) out.push(show(args[i], true));
  return out.join(" ");
}

function where(url, line) {
  if (!url) return undefined;
  const file = String(url).split(/[?#]/)[0].split("/").pop() || String(url);
  return file.slice(0, 80) + (line >= 0 ? ":" + (line + 1) : "");
}
function frameAt(st) { const f = st && st.callFrames && st.callFrames[0]; return f ? where(f.url, f.lineNumber) : undefined; }

// Run in the page on the picked node: the chain from its top document down,
// crossing shadow roots and same-origin frames, so the client can open it.
function ancestry() {
  var out = [], n = this;
  while (n) {
    out.push(n);
    n = n.parentNode || (n.host) || (n.nodeType === 9 && n.defaultView && n.defaultView.frameElement) || null;
  }
  return out.reverse();
}

function brief(n, withKids) {
  const o = { id: n.backendNodeId, t: n.nodeType, n: name(n), c: 0 };
  if (n.nodeType === 1 && n.attributes && n.attributes.length) o.a = n.attributes.map((s) => String(s).slice(0, MAX_TEXT));
  if (n.nodeType === 3 || n.nodeType === 8) o.v = String(n.nodeValue || "").slice(0, MAX_TEXT);
  if (n.nodeType === 10) o.v = n.publicId ? "PUBLIC" : "";
  const kids = [...(n.shadowRoots || []), ...(n.contentDocument ? [n.contentDocument] : []), ...(n.children || [])]
    .filter((k) => !(k.nodeType === 3 && !/\S/.test(k.nodeValue || "")));
  o.c = (n.childNodeCount || 0) + (n.shadowRoots ? n.shadowRoots.length : 0) + (n.contentDocument ? 1 : 0);
  if (withKids) { o.k = kids.slice(0, MAX_KIDS).map((k) => brief(k, false)); o.c = o.k.length; }
  return o;
}
function name(n) {
  if (n.nodeType === 11) return "#shadow-root" + (n.shadowRootType ? " (" + n.shadowRootType + ")" : "");
  if (n.nodeType === 1) return (n.localName || n.nodeName || "").toLowerCase();
  return n.nodeName;
}

class Inspector {
  constructor(session) { this.s = session; this.tab = null; this.on = false; this.rootTimer = null; this.conQ = []; this.conTimer = null; }

  handle(tab, m) {
    const id = Number(m.id) | 0;
    switch (m.t) {
      case "insp.open": this.on = true; this._bind(tab); break;
      case "insp.close": this.on = false; this._bind(null); break;
      case "insp.kids": this._run("kids", () => this._kids(id)); break;
      case "insp.hl": this._run("hl", () => id ? this._cdp("Overlay.highlightNode", { backendNodeId: id, highlightConfig: HIGHLIGHT }) : this._cdp("Overlay.hideHighlight")); break;
      case "insp.pick": this._run("pick", () => this._cdp("Overlay.setInspectMode", { mode: m.on ? "searchForNode" : "none", highlightConfig: HIGHLIGHT })); break;
      case "insp.sel": this._run("sel", () => this._info(id)); break;
      case "insp.html": this._run("html", async () => {
        const { outerHTML } = await this._cdp("DOM.getOuterHTML", { backendNodeId: id });
        this.s._send({ t: "insp.html", id, html: String(outerHTML).slice(0, MAX_HTML) });
      }); break;
      case "insp.set": this._run("set", async () => {
        await this._cdp("DOM.setOuterHTML", { nodeId: await this._nodeId(id), outerHTML: String(m.html || "").slice(0, MAX_HTML) });
        this.s._send({ t: "insp.done", id });
      }); break;
      case "insp.del": this._run("del", async () => {
        await this._cdp("DOM.removeNode", { nodeId: await this._nodeId(id) });
        this.s._send({ t: "insp.done", id });
      }); break;
      case "insp.eval": this._run("eval", () => this._eval(m.seq >>> 0, String(m.src || "").slice(0, MAX_EVAL))); break;
      case "insp.conclear":
        if (this.on && this.tab) { this.tab.con = []; this.conQ = []; this._cdp("Runtime.discardConsoleEntries").catch(noop); }
        break;
    }
  }

  // Session calls this as each tab is wired, before Runtime is enabled, so
  // nothing the page logs is missed.
  watch(tab) {
    const cdp = tab.cdp;
    tab.con = [];
    cdp.on("Runtime.consoleAPICalled", ({ type, args, stackTrace }) => {
      if (type === "clear") { this._conReset(tab); return; }
      if (type === "endGroup") return;
      let s = showArgs(args);
      if (type === "assert") s = "Assertion failed" + (s ? ": " + s : "");
      if (type === "startGroup" || type === "startGroupCollapsed") s = "▸ " + s;
      this._log(tab, { l: CON_LEVEL[type] || "log", s, src: frameAt(stackTrace) });
    });
    cdp.on("Runtime.exceptionThrown", ({ exceptionDetails: d }) => {
      const e = d.exception;
      const s = e && e.subtype === "error" ? "Uncaught " + (e.description || "") : d.text + (e ? " " + show(e) : "");
      this._log(tab, { l: "error", s, src: where(d.url, d.lineNumber) || frameAt(d.stackTrace) });
    });
    // Chrome's own messages: failed loads, CSP and mixed-content violations, deprecations.
    cdp.on("Log.entryAdded", ({ entry: e }) => {
      if (e.source === "console-api") return;
      this._log(tab, { l: CON_LEVEL[e.level] || "log", s: String(e.text || ""), src: where(e.url, e.lineNumber) });
    });
    // The main frame navigated: start afresh, as DevTools does without "preserve log".
    cdp.on("Runtime.executionContextsCleared", () => this._conReset(tab));
    cdp.send("Log.enable").catch(noop);
  }

  _log(tab, item) {
    if (item.s.length > CON_TEXT) item.s = item.s.slice(0, CON_TEXT) + "…";
    if (!item.src) delete item.src;
    tab.con.push(item);
    if (tab.con.length > CON_KEEP) tab.con.splice(0, tab.con.length - CON_KEEP);
    if (!this.on || this.tab !== tab) return;
    this.conQ.push(item);
    // A page logging in a tight loop must not flood the socket: batch, and keep the newest.
    if (!this.conTimer) this.conTimer = setTimeout(() => {
      this.conTimer = null;
      let items = this.conQ; this.conQ = [];
      if (!items.length || !this.on || this.s.closed) return;
      if (items.length > CON_BURST) items = [{ l: "info", s: "… " + (items.length - CON_BURST) + " messages skipped" }, ...items.slice(-CON_BURST)];
      this.s._send({ t: "insp.con", items });
    }, 50);
  }

  _conReset(tab) {
    tab.con = [];
    if (this.on && this.tab === tab) { this.conQ = []; this.s._send({ t: "insp.con", reset: true, items: [] }); }
  }

  // replMode allows top-level await and redeclaring let/const, as the DevTools console does.
  async _eval(seq, src) {
    let r;
    try {
      r = await this._cdp("Runtime.evaluate", {
        expression: src, objectGroup: "plover-console", replMode: true, includeCommandLineAPI: true,
        awaitPromise: true, generatePreview: true, userGesture: true,
      });
    } catch (e) {
      this.s._send({ t: "insp.evr", seq, l: "error", s: String(e && e.message || e).replace(/^Protocol error \([^)]*\): /, "") });
      return;
    } finally { this._cdp("Runtime.releaseObjectGroup", { objectGroup: "plover-console" }).catch(noop); }
    const d = r.exceptionDetails, e = d && d.exception;
    const s = d ? "Uncaught " + (e ? (e.subtype === "error" ? e.description : show(e)) : d.text) : show(r.result);
    this.s._send({ t: "insp.evr", seq, l: d ? "error" : "res", s: String(s).slice(0, CON_TEXT * 4) });
  }

  // The inspector follows the active tab. Session calls this on every switch.
  follow(tab) { if (this.on && tab !== this.tab) this._bind(tab); }
  forget(tab) { if (this.tab === tab) this.tab = null; }

  async _bind(tab) {
    const prev = this.tab;
    this.tab = tab || null;
    if (prev && prev !== this.tab && prev.cdp) {
      prev.cdp.send("Overlay.setInspectMode", { mode: "none", highlightConfig: {} }).catch(noop);
      prev.cdp.send("Overlay.hideHighlight").catch(noop);
      for (const d of ["Overlay.disable", "CSS.disable", "DOM.disable"]) prev.cdp.send(d).catch(noop);
    }
    if (!this.tab || !this.tab.cdp) return;
    const t = this.tab;
    if (!t.inspWired) {
      t.inspWired = true;
      // The page replaced its document (navigation, document.open): ids are void.
      t.cdp.on("DOM.documentUpdated", () => { if (this.on && this.tab === t) this._root(); });
      t.cdp.on("Overlay.inspectNodeRequested", ({ backendNodeId }) => { if (this.on && this.tab === t) this._run("pick", () => this._reveal(backendNodeId)); });
      t.cdp.on("Overlay.inspectModeCanceled", () => { if (this.tab === t) this.s._send({ t: "insp.pick", on: false }); });
    }
    clearTimeout(this.conTimer); this.conTimer = null; this.conQ = [];
    this.s._send({ t: "insp.con", reset: true, items: (t.con || []).slice() });
    this._run("open", async () => {
      await Promise.all([t.cdp.send("DOM.enable"), t.cdp.send("CSS.enable").catch(noop), t.cdp.send("Overlay.enable")]);
      await this._root();
    });
  }

  // Debounced: a navigation can fire documentUpdated several times.
  _root() {
    clearTimeout(this.rootTimer);
    return new Promise((resolve) => {
      this.rootTimer = setTimeout(() => this._run("root", async () => {
        const t = this.tab;
        const { root } = await this._cdp("DOM.getDocument", { depth: 0 });   // the agent needs a document before node pushes
        const { node } = await this._cdp("DOM.describeNode", { backendNodeId: root.backendNodeId, depth: 1, pierce: true });
        if (this.tab === t) this.s._send({ t: "insp.root", tab: t.id, url: t.url, node: brief(node, true) });
      }).then(resolve), 60);
    });
  }

  async _kids(id) {
    try {
      const { node } = await this._cdp("DOM.describeNode", { backendNodeId: id, depth: 1, pierce: true });
      this.s._send({ t: "insp.kids", id, kids: brief(node, true).k || [] });
    } catch (_) { this.s._send({ t: "insp.kids", id, gone: true }); }
  }

  async _reveal(backendNodeId) {
    await this._cdp("Overlay.setInspectMode", { mode: "none", highlightConfig: HIGHLIGHT }).catch(noop);
    this.s._send({ t: "insp.pick", on: false });
    const { object } = await this._cdp("DOM.resolveNode", { backendNodeId });
    const arr = await this._cdp("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: ancestry.toString(), returnByValue: false });
    const { result } = await this._cdp("Runtime.getProperties", { objectId: arr.result.objectId, ownProperties: true });
    const ids = [];
    for (const p of result.filter((r) => /^\d+$/.test(r.name)).sort((a, b) => a.name - b.name)) {
      const { node } = await this._cdp("DOM.describeNode", { objectId: p.value.objectId });
      ids.push(node.backendNodeId);
    }
    this._cdp("Runtime.releaseObject", { objectId: arr.result.objectId }).catch(noop);
    this._cdp("Runtime.releaseObject", { objectId: object.objectId }).catch(noop);
    // Every ancestor's children, so the client can open the whole path at once.
    const chain = [];
    for (const a of ids.slice(0, -1)) {
      const { node } = await this._cdp("DOM.describeNode", { backendNodeId: a, depth: 1, pierce: true });
      chain.push({ id: a, kids: brief(node, true).k || [] });
    }
    this.s._send({ t: "insp.reveal", id: backendNodeId, chain });
    await this._info(backendNodeId, true);
  }

  async _info(id, noScroll) {
    const { node } = await this._cdp("DOM.describeNode", { backendNodeId: id, depth: 0 });
    const out = { t: "insp.info", id, node: brief(node, false), box: null, css: [] };
    if (node.nodeType === 1) {
      if (!noScroll) this._cdp("DOM.scrollIntoViewIfNeeded", { backendNodeId: id }).catch(noop);
      try { const { model } = await this._cdp("DOM.getBoxModel", { backendNodeId: id }); out.box = { w: model.width, h: model.height }; } catch (_) {}
      try {
        const { computedStyle } = await this._cdp("CSS.getComputedStyleForNode", { nodeId: await this._nodeId(id) });
        out.css = computedStyle.map((p) => [p.name, String(p.value).slice(0, MAX_TEXT)]);
      } catch (_) {}
    }
    this.s._send(out);
  }

  async _nodeId(backendNodeId) {
    const { nodeIds } = await this._cdp("DOM.pushNodesByBackendIdsToFrontend", { backendNodeIds: [backendNodeId] });
    if (!nodeIds[0]) throw new Error("That element is no longer in the page.");
    return nodeIds[0];
  }

  _cdp(method, params) {
    const t = this.tab;
    if (!t || !t.cdp) return Promise.reject(new Error("No tab to inspect."));
    return t.cdp.send(method, params || {});
  }

  _run(what, fn) {
    if (!this.on || !this.tab) return Promise.resolve();
    return Promise.resolve().then(fn).catch((e) => {
      if (this.on && !this.s.closed) this.s._send({ t: "insp.err", op: what, msg: String(e && e.message || e).replace(/^Protocol error \([^)]*\): /, "").slice(0, 300) });
    });
  }
}

module.exports = { Inspector };
