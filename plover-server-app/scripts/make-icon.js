"use strict";
// Renders build/icon.png (512x512) from the Plover mark, for electron-builder.
// Run once with Electron (ELECTRON_RUN_AS_NODE unset): npx electron scripts/make-icon.js
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="512" height="512"><defs>' +
  '<linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#14b8a6"/><stop offset="1" stop-color="#0ea5e9"/></linearGradient>' +
  '<mask id="k"><rect width="16" height="16" fill="#fff"/><circle cx="8.5" cy="7" r="3.5" fill="#000"/></mask></defs>' +
  '<rect width="32" height="32" rx="7" fill="url(#g)"/><g transform="translate(3.6 4) scale(1.55)"><g mask="url(#k)">' +
  '<circle r="5.79" cx="9.39" cy="8.12" fill="#fff" fill-opacity=".04" stroke="#fff" stroke-width="1.25"/>' +
  '<polyline fill="none" stroke="#fff" stroke-width="1.25" points="4.5 5 .89 7.67 4 10.5" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<path d="M3.86 10.11 15.2 7.74 14.34 10.93 12.22 13.22 8.95 14.03 6.28 12.78 4.49 11.18Z" fill="#fff"/></g>' +
  '<circle r="1.94" cx="8.5" cy="7" fill="none" stroke="#fff" stroke-width="1.25"/></g></svg>';

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 512, height: 512, show: false, transparent: true, frame: false, useContentSize: true,
    webPreferences: { offscreen: true } });
  await win.loadURL("data:text/html," + encodeURIComponent('<body style="margin:0;background:transparent">' + svg + "</body>"));
  await new Promise((r) => setTimeout(r, 500));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });
  const out = path.join(__dirname, "..", "build", "icon.png");
  fs.writeFileSync(out, img.resize({ width: 512, height: 512 }).toPNG());
  console.log("wrote " + out);
  app.quit();
});
