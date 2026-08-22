const { app, BrowserWindow, ipcMain, dialog, nativeTheme, Menu, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const iconv = require("iconv-lite");

const build = Number.parseInt(os.release().split(".")[2] || "0", 10);
const isWin11 = process.platform === "win32" && build >= 22000;

const isDev = !app.isPackaged;
if (isDev) {
  app.setPath("userData", path.join(__dirname, "..", ".userdata"));
  app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
}
const USER_DIR = () => app.getPath("userData");
const SETTINGS_PATH = () => path.join(USER_DIR(), "settings.json");
const SESSION_PATH = () => path.join(USER_DIR(), "session.json");
const RECENT_PATH = () => path.join(USER_DIR(), "recent.json");
const TASKS_PATH = () => path.join(USER_DIR(), "tasks.json");

const DEFAULT_SETTINGS = {
  theme: "dark",
  fontFamily: "Consolas",
  fontSize: 11,
  openingFiles: "autodetect",
  startup: "session",
  formatting: true,
  wordWrap: true,
};

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function applyTheme(theme) {
  if (theme === "light") nativeTheme.themeSource = "light";
  else if (theme === "dark") nativeTheme.themeSource = "dark";
  else nativeTheme.themeSource = "system";
}

function overlayColors() {
  const dark = nativeTheme.shouldUseDarkColors;
  return {
    color: dark ? "#202020" : "#F3F3F3",
    symbolColor: dark ? "#FFFFFF" : "#000000",
    height: 40,
  };
}

function createWindow(options) {
  const opts = typeof options === "string" ? { initialFile: options } : options || {};
  const { initialFile, initialTab, detached } = opts;
  const isDetached = Boolean(detached || initialTab);
  const settings = { ...DEFAULT_SETTINGS, ...readJson(SETTINGS_PATH(), {}) };
  applyTheme(settings.theme);

  const win = new BrowserWindow({
    width: 1100,
    height: 740,
    minWidth: 520,
    minHeight: 360,
    show: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#202020" : "#F3F3F3",
    autoHideMenuBar: true,
    title: "Notes+",
    ...(fs.existsSync(path.join(__dirname, "..", "src", "assets", "icon.png"))
      ? { icon: path.join(__dirname, "..", "src", "assets", "icon.png") }
      : {}),
    titleBarStyle: "hidden",
    titleBarOverlay: overlayColors(),
    ...(isWin11 ? { backgroundMaterial: "mica" } : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
      sandbox: false,
    },
  });

  Menu.setApplicationMenu(null);

  nativeTheme.on("updated", () => {
    if (!win.isDestroyed()) {
      try {
        win.setTitleBarOverlay(overlayColors());
      } catch {
        /* overlay not available */
      }
      win.webContents.send("theme:system-changed", nativeTheme.shouldUseDarkColors);
    }
  });

  win.once("ready-to-show", () => win.show());

  win.on("close", (e) => {
    if (win.closeAllowed) return;
    e.preventDefault();
    win.webContents.send("window:close-request");
    clearTimeout(win.closeFallback);
    win.closeFallback = setTimeout(() => {
      if (win.isDestroyed() || win.closeAllowed) return;
      win.closeAllowed = true;
      win.close();
    }, 2500);
  });

  if (isDev) {
    const devUrl = `http://127.0.0.1:5174/${isDetached ? "?detached=1" : ""}`;
    let attempts = 0;
    const loadDev = () => {
      if (!win.isDestroyed()) win.loadURL(devUrl);
    };
    win.webContents.on("did-fail-load", (_event, _code, _desc, url, isMainFrame) => {
      if (!isMainFrame || !url.startsWith("http://127.0.0.1:5174") || attempts >= 20) return;
      attempts += 1;
      setTimeout(loadDev, 400);
    });
    loadDev();
  } else {
    win.loadFile(path.join(__dirname, "..", "dist", "index.html"), {
      query: isDetached ? { detached: "1" } : {},
    });
  }

  win.webContents.once("did-finish-load", () => {
    if (initialFile) win.webContents.send("file:open-external", initialFile);
    if (initialTab) win.webContents.send("tab:open-detached", initialTab);
  });

  return win;
}

function detectEncoding(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { encoding: "UTF-8", text: buf.slice(3).toString("utf8"), bom: true };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { encoding: "UTF-16 LE", text: iconv.decode(buf.slice(2), "utf16-le"), bom: true };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { encoding: "UTF-16 BE", text: iconv.decode(buf.slice(2), "utf16-be"), bom: true };
  }
  return { encoding: "UTF-8", text: buf.toString("utf8"), bom: false };
}

function decodeBuffer(buf, encoding) {
  switch (encoding) {
    case "UTF-16 LE":
      return iconv.decode(buf[0] === 0xff && buf[1] === 0xfe ? buf.slice(2) : buf, "utf16-le");
    case "UTF-16 BE":
      return iconv.decode(buf[0] === 0xfe && buf[1] === 0xff ? buf.slice(2) : buf, "utf16-be");
    case "ANSI":
      return iconv.decode(buf, "win1252");
    default:
      return buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
        ? buf.slice(3).toString("utf8")
        : buf.toString("utf8");
  }
}

function encodeText(text, encoding) {
  switch (encoding) {
    case "UTF-16 LE":
      return Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode(text, "utf16-le")]);
    case "UTF-16 BE":
      return Buffer.concat([Buffer.from([0xfe, 0xff]), iconv.encode(text, "utf16-be")]);
    case "ANSI":
      return iconv.encode(text, "win1252");
    default:
      return Buffer.from(text, "utf8");
  }
}

function withLineEndings(text, lineEnding) {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return lineEnding === "LF" ? normalized : normalized.replace(/\n/g, "\r\n");
}

function detectLineEnding(text) {
  return text.includes("\r\n") ? "CRLF" : "LF";
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const file = argv.find((a) => /\.(txt|md|log|ini|json|xml|csv)$/i.test(a) && fs.existsSync(a));
    const wins = BrowserWindow.getAllWindows();
    if (wins[0]) {
      if (wins[0].isMinimized()) wins[0].restore();
      wins[0].focus();
      if (file) wins[0].webContents.send("file:open-external", file);
    }
  });
}

app.whenReady().then(() => {
  const fileArg = process.argv.find((a) => /\.(txt|md|log|ini|json|xml|csv)$/i.test(a) && fs.existsSync(a));
  createWindow(fileArg);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("settings:get", () => ({ ...DEFAULT_SETTINGS, ...readJson(SETTINGS_PATH(), {}) }));
ipcMain.handle("settings:set", (_e, settings) => {
  writeJson(SETTINGS_PATH(), settings);
  applyTheme(settings.theme);
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.setTitleBarOverlay(overlayColors());
    } catch {
      /* ignore */
    }
  }
  return settings;
});

ipcMain.handle("session:get", () => readJson(SESSION_PATH(), null));
ipcMain.handle("session:set", (_e, session) => {
  writeJson(SESSION_PATH(), session);
});

ipcMain.handle("tasks:get", () => readJson(TASKS_PATH(), []));
ipcMain.handle("tasks:set", (_e, tasks) => {
  writeJson(TASKS_PATH(), Array.isArray(tasks) ? tasks : []);
});

ipcMain.handle("recent:get", () => readJson(RECENT_PATH(), []));
ipcMain.handle("recent:add", (_e, filePath) => {
  const recent = readJson(RECENT_PATH(), []).filter((p) => p !== filePath);
  recent.unshift(filePath);
  writeJson(RECENT_PATH(), recent.slice(0, 12));
  return recent.slice(0, 12);
});

ipcMain.handle("dialog:open", async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const result = await dialog.showOpenDialog(win, {
    title: "Open",
    properties: ["openFile"],
    filters: [
      { name: "Text documents", extensions: ["txt", "md", "log", "ini", "json", "xml", "csv"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return readFilePayload(result.filePaths[0]);
});

ipcMain.handle("dialog:save", async (e, { filePath, content, encoding, lineEnding, suggestedName }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  let target = filePath;
  if (!target) {
    const result = await dialog.showSaveDialog(win, {
      title: "Save as",
      defaultPath: suggestedName || "Untitled.txt",
      filters: [
        { name: "Text documents", extensions: ["txt"] },
        { name: "Markdown", extensions: ["md"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (result.canceled || !result.filePath) return null;
    target = result.filePath;
  }
  const body = withLineEndings(content, lineEnding || "CRLF");
  fs.writeFileSync(target, encodeText(body, encoding || "UTF-8"));
  return { filePath: target, title: path.basename(target) };
});

ipcMain.handle("file:read", (_e, filePath) => readFilePayload(filePath));

ipcMain.handle("dialog:unsaved", async (e, name) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const result = await dialog.showMessageBox(win, {
    type: "warning",
    buttons: ["Save", "Don't save", "Cancel"],
    defaultId: 0,
    cancelId: 2,
    title: "Notes+",
    message: `Do you want to save changes to ${name}?`,
  });
  return ["save", "discard", "cancel"][result.response];
});

ipcMain.handle("window:new", () => {
  createWindow({ detached: true });
});

ipcMain.handle("window:open-tab", (_e, tab) => {
  createWindow({ detached: true, initialTab: tab });
});

ipcMain.handle("window:close-ok", (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  win.closeAllowed = true;
  win.close();
});

ipcMain.handle("window:print", (e) => {
  e.sender.print();
});

ipcMain.handle("shell:show", (_e, filePath) => {
  if (filePath) shell.showItemInFolder(filePath);
});

ipcMain.handle("theme:is-dark", () => nativeTheme.shouldUseDarkColors);

function readFilePayload(filePath) {
  const buf = fs.readFileSync(filePath);
  const settings = { ...DEFAULT_SETTINGS, ...readJson(SETTINGS_PATH(), {}) };
  let encoding = "UTF-8";
  let text;
  if (settings.openingFiles === "utf8") {
    text = decodeBuffer(buf, "UTF-8");
    encoding = "UTF-8";
  } else {
    const detected = detectEncoding(buf);
    encoding = detected.encoding;
    text = detected.text;
  }
  const lineEnding = detectLineEnding(text);
  return {
    filePath,
    title: path.basename(filePath),
    content: text.replace(/\r\n/g, "\n").replace(/\r/g, "\n"),
    encoding,
    lineEnding,
  };
}
