const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const localDist = path.resolve(__dirname, "..", ".electron", "dist");
if (fs.existsSync(path.join(localDist, "electron.exe")) || fs.existsSync(path.join(localDist, "electron"))) {
  process.env.ELECTRON_OVERRIDE_DIST_PATH = localDist;
}

const electronExe = require("electron");
const child = spawn(electronExe, [path.resolve(__dirname, "..")], {
  stdio: "inherit",
  env: process.env,
  windowsHide: false,
});

child.on("exit", (code) => process.exit(code ?? 0));
