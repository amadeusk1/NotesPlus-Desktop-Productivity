const { spawn } = require("child_process");
const path = require("path");

process.env.ELECTRON_OVERRIDE_DIST_PATH = path.resolve(__dirname, "..", ".electron", "dist");

const electronExe = require("electron");
const child = spawn(electronExe, [path.resolve(__dirname, "..")], {
  stdio: "inherit",
  env: process.env,
  windowsHide: false,
});

child.on("exit", (code) => process.exit(code ?? 0));
