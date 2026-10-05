"use strict";
// Runs server.js or agent.js under the app's bundled Node runtime. Windows has
// no signals to send a child, so the app's "stop" message is turned into the
// SIGTERM those scripts already shut down cleanly on (server.js closes its
// sessions and Chromium). If the app itself goes away, stop too.

const path = require("path");

const script = path.resolve(process.argv[2] || "");
const stop = () => process.emit("SIGTERM", "SIGTERM");
process.on("message", (m) => { if (m === "stop") stop(); });
process.on("disconnect", stop);
require(script);
