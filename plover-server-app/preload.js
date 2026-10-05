"use strict";
const { contextBridge, ipcRenderer } = require("electron");

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
const EVENTS = new Set(["runtime", "log", "cloudflared-progress"]);

contextBridge.exposeInMainWorld("plover", {
  list: call("list"),
  defaults: call("defaults"),
  create: call("create"),
  update: call("update"),
  remove: call("remove"),
  regenerateToken: call("regenerate-token"),
  setTerminalPassword: call("set-terminal-password"),
  start: call("start"),
  stop: call("stop"),
  restart: call("restart"),
  logs: call("logs"),
  clearLogs: call("clear-logs"),
  downloadHtml: call("download-html"),
  exportRelay: call("export-relay"),
  testRelay: call("test-relay"),
  cloudflaredStatus: call("cloudflared-status"),
  installCloudflared: call("install-cloudflared"),
  pickFile: call("pick-file"),
  copy: call("copy"),
  openExternal: call("open-external"),
  on: (channel, cb) => {
    if (!EVENTS.has(channel)) return;
    ipcRenderer.on(channel, (_e, payload) => cb(payload));
  },
});
