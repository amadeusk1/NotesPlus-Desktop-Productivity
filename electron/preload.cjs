const { contextBridge, ipcRenderer } = require("electron");

let pendingExternalFile = null;
let pendingDetachedTab = null;
let openExternalHandler = null;
let openDetachedHandler = null;

ipcRenderer.on("file:open-external", (_e, filePath) => {
  pendingExternalFile = filePath;
  openExternalHandler?.(filePath);
});

ipcRenderer.on("tab:open-detached", (_e, tab) => {
  pendingDetachedTab = tab;
  openDetachedHandler?.(tab);
});

contextBridge.exposeInMainWorld("notesPlus", {
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setSettings: (settings) => ipcRenderer.invoke("settings:set", settings),
  getSession: () => ipcRenderer.invoke("session:get"),
  setSession: (session) => ipcRenderer.invoke("session:set", session),
  getRecent: () => ipcRenderer.invoke("recent:get"),
  addRecent: (filePath) => ipcRenderer.invoke("recent:add", filePath),
  openDialog: () => ipcRenderer.invoke("dialog:open"),
  saveDialog: (payload) => ipcRenderer.invoke("dialog:save", payload),
  readFile: (filePath) => ipcRenderer.invoke("file:read", filePath),
  unsavedDialog: (name) => ipcRenderer.invoke("dialog:unsaved", name),
  newWindow: () => ipcRenderer.invoke("window:new"),
  openTabInNewWindow: (tab) => ipcRenderer.invoke("window:open-tab", tab),
  allowClose: () => ipcRenderer.invoke("window:close-ok"),
  print: () => ipcRenderer.invoke("window:print"),
  showInFolder: (filePath) => ipcRenderer.invoke("shell:show", filePath),
  isSystemDark: () => ipcRenderer.invoke("theme:is-dark"),
  onOpenExternal: (cb) => {
    openExternalHandler = cb;
    if (pendingExternalFile) cb(pendingExternalFile);
  },
  onOpenDetachedTab: (cb) => {
    openDetachedHandler = cb;
    if (pendingDetachedTab) cb(pendingDetachedTab);
  },
  onSystemTheme: (cb) => {
    ipcRenderer.on("theme:system-changed", (_e, isDark) => cb(isDark));
  },
  onCloseRequest: (cb) => {
    ipcRenderer.on("window:close-request", () => cb());
  },
});
