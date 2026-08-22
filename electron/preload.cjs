const { contextBridge, ipcRenderer } = require("electron");

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
  print: () => ipcRenderer.invoke("window:print"),
  showInFolder: (filePath) => ipcRenderer.invoke("shell:show", filePath),
  isSystemDark: () => ipcRenderer.invoke("theme:is-dark"),
  onOpenExternal: (cb) => {
    ipcRenderer.on("file:open-external", (_e, filePath) => cb(filePath));
  },
  onSystemTheme: (cb) => {
    ipcRenderer.on("theme:system-changed", (_e, isDark) => cb(isDark));
  },
});
