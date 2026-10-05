"use strict";
// Owns the one Chromium process every session shares. Each session gets its
// own browser context (separate cookies, storage and cache), so sessions are
// isolated from each other without paying for a browser apiece.

const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

const noop = () => {};

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const local = process.env.LOCALAPPDATA || "";
  const candidates = {
    win32: [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      path.join(local, "Google\\Chrome\\Application\\chrome.exe"),
      "C:\\Program Files\\Chromium\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ],
    darwin: [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ],
  }[process.platform] || [
    "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium",
    "/usr/bin/chromium-browser", "/snap/bin/chromium", "/usr/bin/microsoft-edge",
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

class Hub {
  constructor(log) {
    this.log = log;
    this.launching = null;
    this.browser = null;
    this.userAgent = "";
    this.targets = new Map();       // CDP targetId -> tab, for title/url updates
    this.favicons = new Map();      // icon URL -> data: URI ("" when it failed)
    this.onCrash = noop;
  }

  // Launch on first use, and again after a crash.
  getBrowser() {
    if (this.browser && this.browser.connected) return Promise.resolve(this.browser);
    if (!this.launching) this.launching = this._launch().finally(() => { this.launching = null; });
    return this.launching;
  }

  async _launch() {
    const executablePath = findChrome();
    if (!executablePath) throw new Error("No Chrome, Chromium or Edge found. Set CHROME_PATH.");
    const args = [
      "--no-first-run", "--no-default-browser-check", "--mute-audio",
      "--disable-features=Translate,MediaRouter,OptimizationHints",
      "--window-size=1280,800",
    ];
    if (process.platform === "linux") args.push("--disable-dev-shm-usage");
    if (process.getuid && process.getuid() === 0) args.push("--no-sandbox");   // Chromium refuses to sandbox as root
    const browser = await puppeteer.launch({
      executablePath, headless: true, pipe: true, args,
      defaultViewport: null,          // sessions emulate the viewer's viewport themselves
      handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
    });
    // Sites refuse or degrade "HeadlessChrome", so tabs present the ordinary UA.
    this.userAgent = (await browser.userAgent()).replace(/HeadlessChrome/g, "Chrome");
    const cdp = await browser.target().createCDPSession();
    cdp.on("Target.targetInfoChanged", ({ targetInfo }) => {
      const tab = this.targets.get(targetInfo.targetId);
      if (tab) tab.session._targetInfo(tab, targetInfo);
    });
    await cdp.send("Target.setDiscoverTargets", { discover: true });
    this.cdp = cdp;
    browser.on("disconnected", () => {
      if (this.browser !== browser) return;
      this.browser = null; this.cdp = null; this.targets.clear();
      this.log("browser disconnected");
      this.onCrash();
    });
    this.browser = browser;
    this.log("browser " + (await browser.version()) + " (" + executablePath + ")");
    return browser;
  }

  async newContext() {
    const browser = await this.getBrowser();
    const ctx = await browser.createBrowserContext();
    // Downloads would land on the server's disk; there is nowhere to hand them to the viewer.
    await this.cdp.send("Browser.setDownloadBehavior", { behavior: "deny", browserContextId: ctx.id }).catch(noop);
    return ctx;
  }

  // Favicons reach the client as data: URIs only, so the viewer never fetches
  // anything itself. Fetched without cookies; failures are cached as "".
  async favicon(href) {
    if (!href) return "";
    if (href.startsWith("data:image/")) return href.length <= 90000 ? href : "";
    if (!/^https?:\/\//i.test(href)) return "";
    if (this.favicons.has(href)) return this.favicons.get(href);
    let out = "";
    try {
      const res = await fetch(href, { signal: AbortSignal.timeout(4000), headers: { "user-agent": this.userAgent } });
      const type = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      const buf = Buffer.from(await res.arrayBuffer());
      const ok = res.ok && buf.length > 0 && buf.length <= 64 * 1024;
      const mime = type.startsWith("image/") ? type : /\.ico(\?|$)/i.test(href) ? "image/x-icon" : "";
      if (ok && mime) out = "data:" + mime + ";base64," + buf.toString("base64");
    } catch (_) {}
    if (this.favicons.size > 500) this.favicons.delete(this.favicons.keys().next().value);
    this.favicons.set(href, out);
    return out;
  }

  async close() {
    const b = this.browser; this.browser = null;
    if (b) await b.close().catch(noop);
  }
}

module.exports = { Hub };
