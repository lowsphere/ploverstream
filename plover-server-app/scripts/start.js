"use strict";
// `npm start`: launches the app with Electron. Terminals inside VS Code (an
// Electron app) export ELECTRON_RUN_AS_NODE, which would start Electron as
// plain Node, so it is cleared for the child.
const { spawn } = require("child_process");
const electron = require("electron");

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [".", ...process.argv.slice(2)], { cwd: require("path").join(__dirname, ".."), env, stdio: "inherit" });
child.on("exit", (code) => process.exit(code || 0));
