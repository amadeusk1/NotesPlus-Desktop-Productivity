import {
  applyLinePrefix,
  createRichEditor,
  cursorFromIndex,
  findNext,
  findPrev,
  htmlToMarkdown,
  indexFromLineCol,
  markdownToHtml,
  stripMarkdown,
  wrapSyntax,
} from "./editor.js";

const api = window.notesPlus;
const $ = (id) => document.getElementById(id);
const detached = new URLSearchParams(location.search).has("detached");

const state = {
  settings: {
    theme: "dark",
    fontFamily: "Consolas",
    fontSize: 11,
    openingFiles: "autodetect",
    startup: "session",
    formatting: true,
    wordWrap: true,
  },
  tabs: [],
  activeId: null,
  untitled: 0,
  zoom: 1,
  recent: [],
  showSettings: false,
  showBlank: false,
  tasks: [],
};

let rich;
let persistTimer;
let tasksTimer;
let editingTaskId = null;
let detailTaskId = null;
const taskFlashTimers = new Map();

function uid() {
  return crypto.randomUUID();
}

function activeTab() {
  return state.tabs.find((t) => t.id === state.activeId) || null;
}

function untitledName() {
  state.untitled += 1;
  return state.untitled === 1 ? "Untitled" : `Untitled ${state.untitled}`;
}

function createTab(partial = {}) {
  return {
    id: uid(),
    title: partial.title || untitledName(),
    filePath: partial.filePath || null,
    content: partial.content || "",
    diskContent: partial.diskContent ?? partial.content ?? "",
    encoding: partial.encoding || "UTF-8",
    lineEnding: partial.lineEnding || "CRLF",
    view: partial.view || (state.settings.formatting ? "formatted" : "syntax"),
    dirty: Boolean(partial.dirty),
  };
}

function isDirty(tab) {
  return tab.content !== tab.diskContent;
}

function applyTheme() {
  const theme = state.settings.theme;
  const set = (dark) => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  };
  if (theme === "system") {
    api.isSystemDark().then(set);
  } else {
    set(theme === "dark");
  }
}

function applyEditorChrome() {
  document.documentElement.style.setProperty("--font-editor", `"${state.settings.fontFamily}", Consolas, monospace`);
  document.documentElement.style.setProperty("--editor-size", `${state.settings.fontSize}pt`);
  document.documentElement.style.setProperty("--zoom", String(state.zoom));
  $("format-toolbar").hidden = !state.settings.formatting;
  $("status-view").hidden = !state.settings.formatting;
  $("status-zoom").textContent = `${Math.round(state.zoom * 100)}%`;
}

function persistSession() {
  if (detached) return;
  flushActive();
  api.setSession({
    tabs: state.tabs.map((t) => ({
      title: t.title,
      filePath: t.filePath,
      content: t.content,
      diskContent: t.diskContent,
      encoding: t.encoding,
      lineEnding: t.lineEnding,
      view: t.view,
      dirty: isDirty(t),
    })),
    activeId: state.tabs.findIndex((t) => t.id === state.activeId),
    zoom: state.zoom,
    untitled: state.untitled,
  });
}

function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistSession, 400);
}

function flushActive() {
  const tab = activeTab();
  if (!tab) return;
  tab.content = currentMarkdown();
  tab.dirty = isDirty(tab);
}

function currentMarkdown() {
  const tab = activeTab();
  if (!tab) return "";
  if (tab.view === "syntax") return $("syntax-editor").value;
  return htmlToMarkdown(rich.getHTML());
}

function currentPlainText() {
  const tab = activeTab();
  if (!tab) return "";
  if (tab.view === "syntax") return $("syntax-editor").value;
  return rich.state.doc.textBetween(0, rich.state.doc.content.size, "\n");
}

function setActiveContent(content, view) {
  if (view === "syntax") {
    $("syntax-editor").value = content;
    $("syntax-editor").hidden = false;
    $("formatted-editor").hidden = true;
    $("syntax-editor").focus();
  } else {
    rich.commands.setContent(markdownToHtml(content), false);
    $("syntax-editor").hidden = true;
    $("formatted-editor").hidden = false;
    rich.commands.focus();
  }
}

function renderTabs() {
  const strip = $("tabstrip");
  strip.innerHTML = "";
  for (const tab of state.tabs) {
    const el = document.createElement("button");
    el.className = `tab${tab.id === state.activeId ? " active" : ""}`;
    el.dataset.id = tab.id;
    el.title = tab.filePath || tab.title;
    const dirty = isDirty(tab);
    el.innerHTML = `
      <span class="tab-title">${escapeHtml(tab.title)}</span>
      ${dirty ? '<span class="tab-dirty"></span>' : ""}
      <span class="tab-close" data-close="${tab.id}" title="Close tab">
        <svg viewBox="0 0 16 16" width="10" height="10"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
      </span>
    `;
    el.addEventListener("click", (e) => {
      if (e.target.closest("[data-close]")) {
        closeTab(tab.id);
        return;
      }
      switchTab(tab.id);
    });
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showTabMenu(e.clientX, e.clientY, tab.id);
    });
    el.draggable = true;
    el.addEventListener("dragstart", (e) => {
      if (e.target.closest("[data-close]")) {
        e.preventDefault();
        return;
      }
      e.dataTransfer.setData("text/tab-id", tab.id);
      e.dataTransfer.effectAllowed = "move";
    });
    el.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    });
    el.addEventListener("drop", (e) => {
      e.preventDefault();
      reorderTabs(e.dataTransfer.getData("text/tab-id"), tab.id);
    });
    strip.appendChild(el);
  }
}

function reorderTabs(fromId, toId) {
  if (!fromId || fromId === toId) return;
  const from = state.tabs.findIndex((t) => t.id === fromId);
  const to = state.tabs.findIndex((t) => t.id === toId);
  if (from < 0 || to < 0) return;
  const [tab] = state.tabs.splice(from, 1);
  state.tabs.splice(to, 0, tab);
  renderTabs();
  schedulePersist();
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function updateStatus() {
  const tab = activeTab();
  if (!tab) return;
  const text = currentMarkdown();
  let index = text.length;
  if (tab.view === "syntax") {
    index = $("syntax-editor").selectionStart;
  } else {
    const sel = rich.state.selection.from;
    index = rich.state.doc.textBetween(0, sel, "\n").length;
  }
  const { line, col } = cursorFromIndex(text, index);
  $("status-cursor").textContent = `Ln ${line}, Col ${col}`;
  $("status-eol").textContent = tab.lineEnding === "LF" ? "Unix (LF)" : "Windows (CRLF)";
  $("status-enc").textContent = tab.encoding;
  $("status-view").textContent = tab.view === "formatted" ? "Formatted" : "Markdown";
  updateToolbarState();
}

function updateToolbarState() {
  const tab = activeTab();
  const formatted = tab && tab.view === "formatted" && state.settings.formatting;
  $("fmt-bold").classList.toggle("active", Boolean(formatted && rich.isActive("bold")));
  $("fmt-italic").classList.toggle("active", Boolean(formatted && rich.isActive("italic")));
  $("fmt-strike").classList.toggle("active", Boolean(formatted && rich.isActive("strike")));
  $("fmt-bullet").classList.toggle("active", Boolean(formatted && rich.isActive("bulletList")));
  $("fmt-number").classList.toggle("active", Boolean(formatted && rich.isActive("orderedList")));
  $("fmt-link").classList.toggle("active", Boolean(formatted && rich.isActive("link")));
  if (formatted && rich.isActive("heading")) {
    $("style-select").value = String(rich.getAttributes("heading").level || "paragraph");
  } else {
    $("style-select").value = "paragraph";
  }
}

function markDirty() {
  const tab = activeTab();
  if (!tab) return;
  tab.content = currentMarkdown();
  tab.dirty = isDirty(tab);
  renderTabs();
  schedulePersist();
}

function switchTab(id) {
  if (state.activeId === id) return;
  flushActive();
  state.activeId = id;
  const tab = activeTab();
  if (!tab) return;
  if (!state.settings.formatting) tab.view = "syntax";
  setActiveContent(tab.content, tab.view);
  applyWrap();
  renderTabs();
  updateStatus();
  $("editor-page").hidden = state.showSettings || state.showBlank;
}

function applyWrap() {
  $("syntax-editor").classList.toggle("wrap", state.settings.wordWrap);
  $("formatted-editor").classList.toggle("wrap", state.settings.wordWrap);
  $("formatted-editor").classList.toggle("nowrap", !state.settings.wordWrap);
}

function addTab(partial) {
  flushActive();
  const tab = createTab(partial);
  state.tabs.push(tab);
  state.activeId = tab.id;
  setActiveContent(tab.content, tab.view);
  applyWrap();
  renderTabs();
  updateStatus();
  schedulePersist();
  return tab;
}

async function closeTab(id) {
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab) return;
  if (tab.id === state.activeId) flushActive();
  if (isDirty(tab) && (tab.filePath || tab.content)) {
    const choice = await api.unsavedDialog(tab.title);
    if (choice === "cancel") return;
    if (choice === "save") {
      const ok = await saveTab(tab, !tab.filePath);
      if (!ok) return;
    }
  }
  const idx = state.tabs.findIndex((t) => t.id === id);
  state.tabs.splice(idx, 1);
  if (!state.tabs.length) {
    addTab();
    return;
  }
  const next = state.tabs[Math.max(0, idx - 1)];
  state.activeId = next.id;
  setActiveContent(next.content, next.view);
  renderTabs();
  updateStatus();
  schedulePersist();
}

async function saveTab(tab, saveAs) {
  if (tab.id === state.activeId) flushActive();
  const result = await api.saveDialog({
    filePath: saveAs ? null : tab.filePath,
    content: tab.content,
    encoding: tab.encoding,
    lineEnding: tab.lineEnding,
    suggestedName: tab.filePath ? undefined : `${tab.title}.txt`,
  });
  if (!result) return false;
  tab.filePath = result.filePath;
  tab.title = result.title;
  tab.diskContent = tab.content;
  tab.dirty = false;
  renderTabs();
  await api.addRecent(result.filePath);
  state.recent = await api.getRecent();
  schedulePersist();
  return true;
}

async function openPayload(payload) {
  if (!payload) return;
  const existing = state.tabs.find((t) => t.filePath === payload.filePath);
  if (existing) {
    switchTab(existing.id);
    return;
  }
  const empty = state.tabs.length === 1 && !state.tabs[0].filePath && !state.tabs[0].content;
  const data = {
    title: payload.title,
    filePath: payload.filePath,
    content: payload.content,
    diskContent: payload.content,
    encoding: payload.encoding,
    lineEnding: payload.lineEnding,
    dirty: false,
  };
  if (empty) {
    Object.assign(state.tabs[0], createTab(data), { id: state.tabs[0].id });
    state.activeId = state.tabs[0].id;
    setActiveContent(state.tabs[0].content, state.tabs[0].view);
    renderTabs();
    updateStatus();
  } else {
    addTab(data);
  }
  await api.addRecent(payload.filePath);
  state.recent = await api.getRecent();
}

function toggleView() {
  const tab = activeTab();
  if (!tab || !state.settings.formatting) return;
  flushActive();
  tab.view = tab.view === "formatted" ? "syntax" : "formatted";
  setActiveContent(tab.content, tab.view);
  updateStatus();
  schedulePersist();
}

function applyFormat(action) {
  const tab = activeTab();
  if (!tab) return;
  if (tab.view === "formatted") {
    const chain = rich.chain().focus();
    switch (action) {
      case "bold": chain.toggleBold().run(); break;
      case "italic": chain.toggleItalic().run(); break;
      case "strike": chain.toggleStrike().run(); break;
      case "bullet": chain.toggleBulletList().run(); break;
      case "number": chain.toggleOrderedList().run(); break;
      case "clear": chain.unsetAllMarks().clearNodes().run(); break;
      default: break;
    }
    return;
  }
  const area = $("syntax-editor");
  const start = area.selectionStart;
  const end = area.selectionEnd;
  let next;
  switch (action) {
    case "bold": next = wrapSyntax(area.value, start, end, "**"); break;
    case "italic": next = wrapSyntax(area.value, start, end, "*"); break;
    case "strike": next = wrapSyntax(area.value, start, end, "~~"); break;
    case "bullet": next = applyLinePrefix(area.value, start, end, "- "); break;
    case "number": next = applyLinePrefix(area.value, start, end, "1. "); break;
    case "clear": next = stripMarkdown(area.value, start, end); break;
    default: return;
  }
  area.value = next.text;
  area.setSelectionRange(next.selectStart, next.selectEnd);
  markDirty();
  updateStatus();
}

async function applyLink() {
  const tab = activeTab();
  if (!tab) return;
  const url = await promptDialog("Insert link", "Address", "https://");
  if (!url) return;
  if (tab.view === "formatted") {
    rich.chain().focus().setLink({ href: url }).run();
    return;
  }
  const area = $("syntax-editor");
  const start = area.selectionStart;
  const end = area.selectionEnd;
  const selected = area.value.slice(start, end) || "link";
  const insert = `[${selected}](${url})`;
  area.value = area.value.slice(0, start) + insert + area.value.slice(end);
  area.setSelectionRange(start, start + insert.length);
  markDirty();
}

function applyStyle(value) {
  const tab = activeTab();
  if (!tab) return;
  if (tab.view === "formatted") {
    if (value === "paragraph") rich.chain().focus().setParagraph().run();
    else rich.chain().focus().toggleHeading({ level: Number(value) }).run();
    return;
  }
  const map = { paragraph: "", 1: "# ", 2: "## ", 3: "### ", 4: "#### ", 5: "##### ", 6: "###### " };
  const area = $("syntax-editor");
  const next = applyLinePrefix(area.value, area.selectionStart, area.selectionEnd, map[value] ?? "");
  area.value = next.text;
  area.setSelectionRange(next.selectStart, next.selectEnd);
  markDirty();
}

function insertDateTime() {
  const stamp = new Date().toLocaleString();
  const tab = activeTab();
  if (!tab) return;
  if (tab.view === "formatted") {
    rich.chain().focus().insertContent(stamp).run();
    return;
  }
  const area = $("syntax-editor");
  const start = area.selectionStart;
  area.setRangeText(stamp, start, area.selectionEnd, "end");
  markDirty();
}

function zoomBy(delta) {
  state.zoom = Math.min(5, Math.max(0.5, Math.round((state.zoom + delta) * 10) / 10));
  applyEditorChrome();
  schedulePersist();
}

function showPage(page) {
  state.showSettings = page === "settings";
  state.showBlank = page === "blank";
  $("settings-page").hidden = page !== "settings";
  $("blank-page").hidden = page !== "blank";
  $("editor-page").hidden = page !== "editor";
  $("app").classList.toggle("page-tasks", page === "blank");
  const switcher = $("open-blank");
  if (page === "blank") {
    switcher.title = "Notes";
    switcher.setAttribute("aria-label", "Notes");
  } else {
    switcher.title = "Tasks";
    switcher.setAttribute("aria-label", "Tasks");
  }
  if (page === "settings") syncSettingsForm();
  if (page === "blank") {
    renderTasks();
    syncTaskDetail();
    $("task-input").focus();
  } else {
    closeTaskDetail();
  }
}

function showSettings(show) {
  showPage(show ? "settings" : "editor");
}

function taskPayload() {
  return state.tasks.map((t) => ({
    id: t.id,
    title: t.title,
    done: t.done,
    createdAt: t.createdAt,
    description: t.description || "",
    dueDate: t.dueDate || "",
  }));
}

function persistTasks() {
  const payload = taskPayload();
  try {
    localStorage.setItem("notesplus-tasks", JSON.stringify(payload));
  } catch {
    /* ignore quota */
  }
  return api.setTasks(payload);
}

function schedulePersistTasks() {
  clearTimeout(tasksTimer);
  tasksTimer = setTimeout(persistTasks, 400);
}

function dueStamp(iso) {
  if (!iso) return Number.POSITIVE_INFINITY;
  const parts = String(iso).split("-").map(Number);
  if (parts.length < 3) return Number.POSITIVE_INFINITY;
  const time = new Date(parts[0], parts[1] - 1, parts[2]).getTime();
  return Number.isFinite(time) ? time : Number.POSITIVE_INFINITY;
}

function byDueThenCreated(a, b) {
  const due = dueStamp(a.dueDate) - dueStamp(b.dueDate);
  if (due !== 0) return due;
  return (a.createdAt || 0) - (b.createdAt || 0);
}

function formatDueDate(iso) {
  if (!iso) return "";
  const parts = iso.split("-").map(Number);
  if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return "";
  const date = new Date(parts[0], parts[1] - 1, parts[2]);
  if (Number.isNaN(date.getTime())) return "";
  const opts = { month: "short", day: "numeric" };
  if (date.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  return date.toLocaleDateString(undefined, opts);
}

function isDueOverdue(iso, done) {
  if (!iso || done) return false;
  const parts = iso.split("-").map(Number);
  const date = new Date(parts[0], parts[1] - 1, parts[2]);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return date < today;
}

function sortedTasks() {
  return [
    ...state.tasks.filter((t) => !t.done).sort(byDueThenCreated),
    ...state.tasks.filter((t) => t.done).sort(byDueThenCreated),
  ];
}

function checkIcon() {
  return '<svg viewBox="0 0 16 16" width="10" height="10"><path d="M3.2 8.2 6.4 11.2 12.8 4.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}

function paintTaskCheck(row, task) {
  const btn = row.querySelector("[data-toggle]");
  if (!btn) return;
  btn.innerHTML = task.done ? checkIcon() : "";
  const label = task.done ? "Mark as not done" : "Mark as done";
  btn.title = label;
  btn.setAttribute("aria-label", label);
}

function clearTaskFlash(id) {
  const timer = taskFlashTimers.get(id);
  if (timer) clearTimeout(timer);
  taskFlashTimers.delete(id);
}

function animateTaskReorder() {
  const list = $("task-list");
  if (!list) return;
  const rows = [...list.querySelectorAll(".task-row")];
  if (!rows.length) return;
  const first = new Map(rows.map((row) => [row.dataset.id, row.getBoundingClientRect()]));
  for (const task of sortedTasks()) {
    const row = list.querySelector(`.task-row[data-id="${task.id}"]`);
    if (row) list.appendChild(row);
  }
  for (const row of rows) {
    const prev = first.get(row.dataset.id);
    if (!prev) continue;
    const next = row.getBoundingClientRect();
    const dy = prev.top - next.top;
    if (!dy) continue;
    row.style.transition = "none";
    row.style.transform = `translateY(${dy}px)`;
    row.classList.add("task-moving");
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        row.style.transition = "transform 0.32s ease";
        row.style.transform = "";
        const done = () => {
          row.style.transition = "";
          row.style.transform = "";
          row.classList.remove("task-moving");
          row.removeEventListener("transitionend", done);
        };
        row.addEventListener("transitionend", done);
      });
    });
  }
}

function renderTasks() {
  const list = $("task-list");
  if (!list) return;
  const tasks = sortedTasks();
  if (!tasks.length) {
    list.innerHTML = '<p class="task-empty">No tasks yet</p>';
    return;
  }
  list.innerHTML = "";
  for (const task of tasks) {
    const row = document.createElement("div");
    row.className = `task-row${task.done ? " done" : ""}${detailTaskId === task.id ? " selected" : ""}`;
    row.dataset.id = task.id;
    const editing = editingTaskId === task.id;
    row.innerHTML = `
      <button type="button" class="task-check" data-toggle="${task.id}" title="${task.done ? "Mark as not done" : "Mark as done"}" aria-label="${task.done ? "Mark as not done" : "Mark as done"}">
        ${task.done ? checkIcon() : ""}
      </button>
      ${editing
        ? `<input class="task-title-input" id="task-edit" value="${escapeHtml(task.title)}" maxlength="240" />`
        : `<button type="button" class="task-title" data-edit="${task.id}">${escapeHtml(task.title)}</button>`}
      ${task.dueDate ? `<span class="task-due${isDueOverdue(task.dueDate, task.done) ? " overdue" : ""}">${escapeHtml(formatDueDate(task.dueDate))}</span>` : ""}
      <button type="button" class="task-open" data-open="${task.id}" title="Open details" aria-label="Open details">
        <svg viewBox="0 0 16 16" width="10" height="10"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <button type="button" class="task-delete" data-delete="${task.id}" title="Delete task" aria-label="Delete task">
        <svg viewBox="0 0 16 16" width="10" height="10"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
      </button>
    `;
    list.appendChild(row);
  }
  list.querySelectorAll("[data-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => toggleTask(btn.dataset.toggle));
  });
  list.querySelectorAll("[data-edit]").forEach((btn) => {
    btn.addEventListener("click", () => startEditTask(btn.dataset.edit));
  });
  list.querySelectorAll("[data-open]").forEach((btn) => {
    btn.addEventListener("click", () => openTaskDetail(btn.dataset.open));
  });
  list.querySelectorAll("[data-delete]").forEach((btn) => {
    btn.addEventListener("click", () => deleteTask(btn.dataset.delete));
  });
  const edit = $("task-edit");
  if (edit) {
    edit.focus();
    edit.select();
    edit.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        finishEditTask(edit.value);
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        editingTaskId = null;
        renderTasks();
      }
    });
    edit.addEventListener("blur", () => finishEditTask(edit.value));
  }
}

function addTask(title) {
  const text = title.trim();
  if (!text) return;
  state.tasks.push({
    id: uid(),
    title: text,
    done: false,
    createdAt: Date.now(),
    description: "",
    dueDate: "",
  });
  $("task-input").value = "";
  editingTaskId = null;
  renderTasks();
  persistTasks();
}

function toggleTask(id) {
  const task = state.tasks.find((t) => t.id === id);
  if (!task) return;
  task.done = !task.done;
  editingTaskId = null;
  persistTasks();
  const row = document.querySelector(`.task-row[data-id="${id}"]`);
  if (!row) {
    renderTasks();
    return;
  }
  row.classList.toggle("done", task.done);
  paintTaskCheck(row, task);
  if (detailTaskId === id) syncTaskDetail();
  row.classList.add("task-flash");
  clearTaskFlash(id);
  taskFlashTimers.set(id, setTimeout(() => {
    taskFlashTimers.delete(id);
    row.classList.remove("task-flash");
    animateTaskReorder();
  }, 280));
}

function deleteTask(id) {
  clearTaskFlash(id);
  state.tasks = state.tasks.filter((t) => t.id !== id);
  if (editingTaskId === id) editingTaskId = null;
  if (detailTaskId === id) closeTaskDetail();
  renderTasks();
  persistTasks();
}

function flushTaskDetail() {
  const task = state.tasks.find((t) => t.id === detailTaskId);
  if (!task) return;
  const title = $("task-detail-title")?.value.trim();
  if (title) task.title = title;
  task.description = $("task-detail-desc")?.value ?? task.description ?? "";
  task.dueDate = $("task-detail-due")?.value || "";
}

function openTaskDetail(id) {
  if (detailTaskId && detailTaskId !== id) flushTaskDetail();
  detailTaskId = id;
  syncTaskDetail();
  renderTasks();
  $("task-detail-desc")?.focus();
}

function closeTaskDetail() {
  if (detailTaskId) {
    flushTaskDetail();
    persistTasks();
  }
  detailTaskId = null;
  const panel = $("task-detail");
  if (panel) panel.hidden = true;
  document.querySelectorAll(".task-row.selected").forEach((row) => row.classList.remove("selected"));
}

function syncTaskDetail() {
  const panel = $("task-detail");
  if (!panel) return;
  const task = state.tasks.find((t) => t.id === detailTaskId);
  if (!task) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  panel.classList.toggle("done", task.done);
  $("task-detail-title").value = task.title;
  $("task-detail-due").value = task.dueDate || "";
  $("task-detail-desc").value = task.description || "";
}

function startEditTask(id) {
  editingTaskId = id;
  renderTasks();
}

function finishEditTask(title) {
  const task = state.tasks.find((t) => t.id === editingTaskId);
  editingTaskId = null;
  if (task) {
    const text = title.trim();
    if (text) task.title = text;
    else {
      if (detailTaskId === task.id) closeTaskDetail();
      state.tasks = state.tasks.filter((t) => t.id !== task.id);
    }
    persistTasks();
  }
  renderTasks();
  if (detailTaskId) syncTaskDetail();
}

function syncSettingsForm() {
  document.querySelectorAll('input[name="theme"]').forEach((el) => {
    el.checked = el.value === state.settings.theme;
  });
  document.querySelectorAll('input[name="opening"]').forEach((el) => {
    el.checked = el.value === state.settings.openingFiles;
  });
  document.querySelectorAll('input[name="startup"]').forEach((el) => {
    el.checked = el.value === state.settings.startup;
  });
  $("font-family").value = state.settings.fontFamily;
  $("font-size").value = String(state.settings.fontSize);
  $("setting-formatting").checked = state.settings.formatting;
  $("setting-wrap").checked = state.settings.wordWrap;
}

async function saveSettings() {
  await api.setSettings(state.settings);
  applyTheme();
  applyEditorChrome();
  applyWrap();
  const tab = activeTab();
  if (tab && !state.settings.formatting && tab.view === "formatted") {
    flushActive();
    tab.view = "syntax";
    setActiveContent(tab.content, "syntax");
  }
  updateStatus();
}

function menuItems() {
  const tab = activeTab();
  return {
    file: [
      { label: "New tab", accel: "Ctrl+N", run: () => addTab() },
      { label: "New window", accel: "Ctrl+Shift+N", run: () => api.newWindow() },
      { sep: true },
      { label: "Open", accel: "Ctrl+O", run: async () => openPayload(await api.openDialog()) },
      { label: "Open recent", submenu: state.recent.length
        ? state.recent.map((p) => ({ label: p, run: async () => openPayload(await api.readFile(p)) }))
        : [{ label: "No recent files", run: () => {} }] },
      { sep: true },
      { label: "Save", accel: "Ctrl+S", run: () => tab && saveTab(tab, false) },
      { label: "Save as", accel: "Ctrl+Shift+S", run: () => tab && saveTab(tab, true) },
      { sep: true },
      { label: "Print", accel: "Ctrl+P", run: () => api.print() },
      { sep: true },
      { label: "Close tab", accel: "Ctrl+W", run: () => tab && closeTab(tab.id) },
      { label: "Exit", run: () => window.close() },
    ],
    edit: [
      { label: "Undo", accel: "Ctrl+Z", run: () => {
        const tab = activeTab();
        if (tab?.view === "formatted") rich.chain().focus().undo().run();
        else document.execCommand("undo");
      } },
      { label: "Redo", accel: "Ctrl+Y", run: () => {
        const tab = activeTab();
        if (tab?.view === "formatted") rich.chain().focus().redo().run();
        else document.execCommand("redo");
      } },
      { sep: true },
      { label: "Cut", accel: "Ctrl+X", run: () => document.execCommand("cut") },
      { label: "Copy", accel: "Ctrl+C", run: () => document.execCommand("copy") },
      { label: "Paste", accel: "Ctrl+V", run: () => document.execCommand("paste") },
      { label: "Delete", accel: "Del", run: () => document.execCommand("delete") },
      { sep: true },
      { label: "Find", accel: "Ctrl+F", run: () => openFind(false) },
      { label: "Find next", accel: "F3", run: () => runFind(1) },
      { label: "Find previous", accel: "Shift+F3", run: () => runFind(-1) },
      { label: "Replace", accel: "Ctrl+H", run: () => openFind(true) },
      { label: "Go to", accel: "Ctrl+G", run: () => goToLine() },
      { sep: true },
      { label: "Select all", accel: "Ctrl+A", run: () => {
        const current = activeTab();
        if (current?.view === "formatted") rich.chain().focus().selectAll().run();
        else document.execCommand("selectAll");
      } },
      { label: "Time/Date", accel: "F5", run: insertDateTime },
      { sep: true },
      { label: "Font", run: () => showSettings(true) },
      { label: "Clear formatting", run: () => applyFormat("clear") },
    ],
    view: [
      { label: "Zoom in", accel: "Ctrl+Plus", run: () => zoomBy(0.1) },
      { label: "Zoom out", accel: "Ctrl+Minus", run: () => zoomBy(-0.1) },
      { label: "Restore default zoom", accel: "Ctrl+0", run: () => { state.zoom = 1; applyEditorChrome(); } },
      { sep: true },
      { label: "Word wrap", check: state.settings.wordWrap, run: async () => {
        state.settings.wordWrap = !state.settings.wordWrap;
        await saveSettings();
      } },
      { sep: true },
      { label: "Formatted", check: tab?.view === "formatted", run: () => { if (tab?.view !== "formatted") toggleView(); } },
      { label: "Markdown", check: tab?.view === "syntax", run: () => { if (tab?.view !== "syntax") toggleView(); } },
    ],
  };
}

let menuActions = [];

function renderMenu(name, anchor) {
  closeMenus();
  menuActions = [];
  const layer = $("menu-layer");
  layer.hidden = false;
  const popup = document.createElement("div");
  popup.className = "menu-popup";
  const rect = anchor.getBoundingClientRect();
  popup.style.left = `${rect.left}px`;
  popup.style.top = `${rect.bottom + 2}px`;
  popup.innerHTML = menuItems()[name].map((item) => menuHtml(item)).join("");
  layer.appendChild(popup);
  anchor.classList.add("open");
  popup.querySelectorAll("[data-run]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const item = menuActions[Number(btn.dataset.run)];
      closeMenus();
      await item?.run?.();
    });
  });
}

function menuHtml(item) {
  if (item.sep) return '<div class="menu-sep"></div>';
  if (item.submenu) {
    return `<div class="menu-sub"><button class="menu-item">${escapeHtml(item.label)} <span class="accel">›</span></button><div class="submenu">${item.submenu.map((sub) => menuHtml(sub)).join("")}</div></div>`;
  }
  const run = menuActions.push(item) - 1;
  const extra = item.check ? " ✓" : "";
  return `<button class="menu-item" data-run="${run}"><span>${escapeHtml(item.label)}${extra}</span><span class="accel">${item.accel || ""}</span></button>`;
}

function closeMenus() {
  $("menu-layer").hidden = true;
  $("menu-layer").innerHTML = "";
  document.querySelectorAll(".menu-trigger").forEach((b) => b.classList.remove("open"));
}

function showTabMenu(x, y, id) {
  closeMenus();
  const layer = $("menu-layer");
  layer.hidden = false;
  const popup = document.createElement("div");
  popup.className = "menu-popup";
  popup.style.left = `${x}px`;
  popup.style.top = `${y}px`;
  const items = [
    { label: "New tab", run: () => addTab() },
    { label: "Close tab", run: () => closeTab(id) },
    { label: "Close others", run: async () => {
      for (const t of [...state.tabs]) if (t.id !== id) await closeTab(t.id);
    } },
    { label: "Close on the right", run: async () => {
      const idx = state.tabs.findIndex((t) => t.id === id);
      for (const t of state.tabs.slice(idx + 1)) await closeTab(t.id);
    } },
    { label: "Move to new window", run: () => moveTabToNewWindow(id) },
    ...(state.tabs.find((t) => t.id === id)?.filePath
      ? [{ label: "Open file location", run: () => api.showInFolder(state.tabs.find((t) => t.id === id).filePath) }]
      : []),
  ];
  popup.innerHTML = items.map((item, i) => `<button class="menu-item" data-i="${i}">${item.label}</button>`).join("");
  layer.appendChild(popup);
  popup.querySelectorAll("[data-i]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      closeMenus();
      await items[Number(btn.dataset.i)].run();
    });
  });
}

function openFind(replace) {
  $("find-flyout").hidden = false;
  $("replace-row").hidden = !replace;
  $("find-input").focus();
  $("find-input").select();
}

function findOptions() {
  return {
    matchCase: $("find-case").checked,
    wrap: $("find-wrap").checked,
    regex: $("find-regex").checked,
  };
}

function runFind(dir) {
  const tab = activeTab();
  if (!tab) return;
  const query = $("find-input").value;
  const text = currentMarkdown();
  let from = 0;
  if (tab.view === "syntax") {
    from = dir > 0 ? $("syntax-editor").selectionEnd : $("syntax-editor").selectionStart;
  }
  const hit = dir > 0
    ? findNext(text, query, from, findOptions())
    : findPrev(text, query, from, findOptions());
  if (!hit) return;
  if (tab.view !== "syntax") {
    tab.view = "syntax";
    setActiveContent(text, "syntax");
    updateStatus();
  }
  $("syntax-editor").focus();
  $("syntax-editor").setSelectionRange(hit.start, hit.end);
  updateStatus();
}

function replaceOne() {
  const area = $("syntax-editor");
  const tab = activeTab();
  if (!tab) return;
  if (tab.view !== "syntax") {
    flushActive();
    tab.view = "syntax";
    setActiveContent(tab.content, "syntax");
  }
  const start = area.selectionStart;
  const end = area.selectionEnd;
  if (end > start && area.value.slice(start, end)) {
    area.setRangeText($("replace-input").value, start, end, "end");
    markDirty();
  }
  runFind(1);
}

function replaceAll() {
  const tab = activeTab();
  if (!tab) return;
  flushActive();
  tab.view = "syntax";
  const opts = findOptions();
  let text = tab.content;
  const query = $("find-input").value;
  const insert = $("replace-input").value;
  if (!query) return;
  try {
    if (opts.regex) {
      text = text.replace(new RegExp(query, opts.matchCase ? "g" : "gi"), insert);
    } else if (opts.matchCase) {
      text = text.split(query).join(insert);
    } else {
      const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      text = text.replace(re, insert);
    }
  } catch {
    return;
  }
  tab.content = text;
  setActiveContent(text, "syntax");
  markDirty();
}

async function goToLine() {
  const value = await promptDialog("Go to line", "Line number", "1");
  if (!value) return;
  const line = Number.parseInt(value, 10);
  if (!Number.isFinite(line)) return;
  const tab = activeTab();
  flushActive();
  if (tab.view !== "syntax") {
    tab.view = "syntax";
    setActiveContent(tab.content, "syntax");
  }
  const index = indexFromLineCol($("syntax-editor").value, line, 1);
  $("syntax-editor").focus();
  $("syntax-editor").setSelectionRange(index, index);
  updateStatus();
}

function promptDialog(title, label, initial = "") {
  return new Promise((resolve) => {
    const layer = $("dialog-layer");
    layer.hidden = false;
    layer.innerHTML = `
      <div class="dialog">
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(label)}</p>
        <input id="dialog-input" value="${escapeHtml(initial)}" />
        <div class="dialog-actions">
          <button id="dialog-cancel">Cancel</button>
          <button class="primary" id="dialog-ok">OK</button>
        </div>
      </div>`;
    const input = $("dialog-input");
    input.focus();
    input.select();
    const finish = (value) => {
      layer.hidden = true;
      layer.innerHTML = "";
      resolve(value);
    };
    $("dialog-ok").onclick = () => finish(input.value.trim());
    $("dialog-cancel").onclick = () => finish(null);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(input.value.trim());
      if (e.key === "Escape") finish(null);
    });
  });
}

function showChooser(anchor, items) {
  closeMenus();
  const layer = $("menu-layer");
  layer.hidden = false;
  const popup = document.createElement("div");
  popup.className = "menu-popup";
  popup.innerHTML = items.map((item, i) => (
    `<button class="menu-item" data-i="${i}"><span>${item.check ? "✓ " : ""}${escapeHtml(item.label)}</span></button>`
  )).join("");
  layer.appendChild(popup);
  const rect = anchor.getBoundingClientRect();
  const pr = popup.getBoundingClientRect();
  popup.style.left = `${Math.max(8, Math.min(rect.right - pr.width, window.innerWidth - pr.width - 8))}px`;
  popup.style.top = `${Math.max(8, rect.top - pr.height - 6)}px`;
  popup.querySelectorAll("[data-i]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      closeMenus();
      await items[Number(btn.dataset.i)].run?.();
    });
  });
}

function showZoomMenu(anchor) {
  showChooser(anchor, [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 5].map((z) => ({
    label: `${Math.round(z * 100)}%`,
    check: Math.abs(state.zoom - z) < 0.01,
    run: () => {
      state.zoom = z;
      applyEditorChrome();
      schedulePersist();
    },
  })));
}

function showEolMenu(anchor) {
  const tab = activeTab();
  if (!tab) return;
  showChooser(anchor, [
    { label: "Windows (CRLF)", check: tab.lineEnding === "CRLF", run: () => { tab.lineEnding = "CRLF"; updateStatus(); schedulePersist(); } },
    { label: "Unix (LF)", check: tab.lineEnding === "LF", run: () => { tab.lineEnding = "LF"; updateStatus(); schedulePersist(); } },
  ]);
}

function showEncMenu(anchor) {
  const tab = activeTab();
  if (!tab) return;
  showChooser(anchor, ["UTF-8", "UTF-16 LE", "ANSI"].map((enc) => ({
    label: enc,
    check: tab.encoding === enc,
    run: () => { tab.encoding = enc; updateStatus(); schedulePersist(); },
  })));
}

function bindUi() {
  $("new-tab").onclick = () => addTab();
  $("open-settings").onclick = () => showSettings(true);
  $("settings-back").onclick = () => showSettings(false);
  $("open-blank").onclick = () => showPage(state.showBlank ? "editor" : "blank");
  $("blank-back").onclick = () => showPage("editor");
  $("task-composer").addEventListener("submit", (e) => {
    e.preventDefault();
    addTask($("task-input").value);
  });
  $("task-detail-close").onclick = () => closeTaskDetail();
  $("task-detail-title").addEventListener("input", () => {
    const task = state.tasks.find((t) => t.id === detailTaskId);
    if (!task) return;
    task.title = $("task-detail-title").value;
    const label = document.querySelector(`.task-title[data-edit="${task.id}"]`);
    if (label) label.textContent = task.title;
    schedulePersistTasks();
  });
  $("task-detail-title").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      $("task-detail-desc").focus();
    }
  });
  $("task-detail-desc").addEventListener("input", () => {
    const task = state.tasks.find((t) => t.id === detailTaskId);
    if (!task) return;
    task.description = $("task-detail-desc").value;
    schedulePersistTasks();
  });
  $("task-detail-due").addEventListener("change", () => {
    const task = state.tasks.find((t) => t.id === detailTaskId);
    if (!task) return;
    task.dueDate = $("task-detail-due").value || "";
    schedulePersistTasks();
    renderTasks();
  });
  $("fmt-bold").onclick = () => applyFormat("bold");
  $("fmt-italic").onclick = () => applyFormat("italic");
  $("fmt-strike").onclick = () => applyFormat("strike");
  $("fmt-link").onclick = () => applyLink();
  $("fmt-bullet").onclick = () => applyFormat("bullet");
  $("fmt-number").onclick = () => applyFormat("number");
  $("fmt-clear").onclick = () => applyFormat("clear");
  $("style-select").onchange = (e) => applyStyle(e.target.value);
  $("status-view").onclick = toggleView;
  $("status-eol").onclick = (e) => showEolMenu(e.currentTarget);
  $("status-enc").onclick = (e) => showEncMenu(e.currentTarget);
  $("status-zoom").onclick = (e) => showZoomMenu(e.currentTarget);
  $("status-cursor").onclick = () => goToLine();
  $("find-close").onclick = () => { $("find-flyout").hidden = true; };
  $("find-next").onclick = () => runFind(1);
  $("find-prev").onclick = () => runFind(-1);
  $("replace-one").onclick = replaceOne;
  $("replace-all").onclick = replaceAll;
  $("find-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") runFind(e.shiftKey ? -1 : 1);
    if (e.key === "Escape") $("find-flyout").hidden = true;
  });

  document.querySelectorAll(".menu-trigger").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (btn.classList.contains("open")) closeMenus();
      else renderMenu(btn.dataset.menu, btn);
    });
  });
  $("menu-layer").addEventListener("click", (e) => {
    if (e.target.id === "menu-layer") closeMenus();
  });

  $("syntax-editor").addEventListener("input", () => { markDirty(); updateStatus(); });
  $("syntax-editor").addEventListener("keyup", updateStatus);
  $("syntax-editor").addEventListener("click", updateStatus);

  document.querySelectorAll('input[name="theme"]').forEach((el) => {
    el.addEventListener("change", async () => { state.settings.theme = el.value; await saveSettings(); });
  });
  document.querySelectorAll('input[name="opening"]').forEach((el) => {
    el.addEventListener("change", async () => { state.settings.openingFiles = el.value; await saveSettings(); });
  });
  document.querySelectorAll('input[name="startup"]').forEach((el) => {
    el.addEventListener("change", async () => { state.settings.startup = el.value; await saveSettings(); });
  });
  $("font-family").addEventListener("change", async () => { state.settings.fontFamily = $("font-family").value; await saveSettings(); });
  $("font-size").addEventListener("change", async () => { state.settings.fontSize = Number($("font-size").value); await saveSettings(); });
  $("setting-formatting").addEventListener("change", async () => { state.settings.formatting = $("setting-formatting").checked; await saveSettings(); });
  $("setting-wrap").addEventListener("change", async () => { state.settings.wordWrap = $("setting-wrap").checked; await saveSettings(); });

  window.addEventListener("keydown", onKey);
  window.addEventListener("beforeunload", () => {
    persistSession();
    persistTasks();
  });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", async (e) => {
    e.preventDefault();
    const files = [...e.dataTransfer.files];
    for (const file of files) {
      if (file.path) openPayload(await api.readFile(file.path));
    }
  });
  window.addEventListener("wheel", (e) => {
    if (e.ctrlKey) {
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? 0.1 : -0.1);
    }
  }, { passive: false });
}

function onKey(e) {
  const key = e.key.toLowerCase();
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && key === "n" && e.shiftKey) { e.preventDefault(); api.newWindow(); return; }
  if (ctrl && key === "n") { e.preventDefault(); addTab(); return; }
  if (ctrl && key === "o") { e.preventDefault(); api.openDialog().then(openPayload); return; }
  if (ctrl && key === "s" && e.shiftKey) { e.preventDefault(); const t = activeTab(); if (t) saveTab(t, true); return; }
  if (ctrl && key === "s") { e.preventDefault(); const t = activeTab(); if (t) saveTab(t, false); return; }
  if (ctrl && key === "w") { e.preventDefault(); const t = activeTab(); if (t) closeTab(t.id); return; }
  if (ctrl && key === "f") { e.preventDefault(); openFind(false); return; }
  if (ctrl && key === "h") { e.preventDefault(); openFind(true); return; }
  if (ctrl && key === "g") { e.preventDefault(); goToLine(); return; }
  if (ctrl && key === "p") { e.preventDefault(); api.print(); return; }
  if (ctrl && key === "b") { e.preventDefault(); applyFormat("bold"); return; }
  if (ctrl && key === "i") { e.preventDefault(); applyFormat("italic"); return; }
  if (ctrl && key === "k") { e.preventDefault(); applyLink(); return; }
  if (ctrl && (e.key === "=" || e.key === "+")) { e.preventDefault(); zoomBy(0.1); return; }
  if (ctrl && e.key === "-") { e.preventDefault(); zoomBy(-0.1); return; }
  if (ctrl && key === "0") { e.preventDefault(); state.zoom = 1; applyEditorChrome(); return; }
  if (ctrl && e.key === "Tab") {
    e.preventDefault();
    const idx = state.tabs.findIndex((t) => t.id === state.activeId);
    const next = e.shiftKey
      ? state.tabs[(idx - 1 + state.tabs.length) % state.tabs.length]
      : state.tabs[(idx + 1) % state.tabs.length];
    switchTab(next.id);
    return;
  }
  if (e.key === "F3") { e.preventDefault(); runFind(e.shiftKey ? -1 : 1); return; }
  if (e.key === "F5") { e.preventDefault(); insertDateTime(); return; }
  if (e.key === "Escape") {
    closeMenus();
    $("find-flyout").hidden = true;
    if (editingTaskId) {
      editingTaskId = null;
      renderTasks();
      return;
    }
    if (detailTaskId) {
      closeTaskDetail();
      return;
    }
    if (state.showSettings || state.showBlank) showPage("editor");
  }
}

async function restore() {
  state.settings = await api.getSettings();
  state.recent = await api.getRecent();
  let storedTasks = [];
  try {
    storedTasks = await api.getTasks();
  } catch {
    storedTasks = [];
  }
  if (!Array.isArray(storedTasks) || storedTasks.length === 0) {
    try {
      const local = JSON.parse(localStorage.getItem("notesplus-tasks") || "[]");
      if (Array.isArray(local) && local.length) storedTasks = local;
    } catch {
      /* ignore */
    }
  }
  state.tasks = Array.isArray(storedTasks) ? storedTasks.filter((t) => t && t.title).map((t) => ({
    id: t.id || uid(),
    title: String(t.title),
    done: Boolean(t.done),
    createdAt: Number(t.createdAt) || 0,
    description: typeof t.description === "string" ? t.description : "",
    dueDate: typeof t.dueDate === "string" ? t.dueDate : "",
  })) : [];
  persistTasks();
  applyTheme();
  applyEditorChrome();
  const session = !detached && state.settings.startup === "session" ? await api.getSession() : null;
  if (session?.tabs?.length) {
    state.untitled = session.untitled || session.tabs.length;
    state.zoom = session.zoom || 1;
    applyEditorChrome();
    state.tabs = session.tabs.map((t) => createTab(t));
    state.activeId = state.tabs[Math.max(0, session.activeId || 0)]?.id || state.tabs[0].id;
    const tab = activeTab();
    if (!state.settings.formatting) tab.view = "syntax";
    setActiveContent(tab.content, tab.view);
  } else {
    addTab();
  }
  applyWrap();
  renderTabs();
  updateStatus();
}

async function moveTabToNewWindow(id) {
  if (id === state.activeId) flushActive();
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab) return;
  await api.openTabInNewWindow({
    title: tab.title,
    filePath: tab.filePath,
    content: tab.content,
    diskContent: tab.diskContent,
    encoding: tab.encoding,
    lineEnding: tab.lineEnding,
    view: tab.view,
    dirty: isDirty(tab),
  });
  removeTabSilent(id);
}

function removeTabSilent(id) {
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  state.tabs.splice(idx, 1);
  if (!state.tabs.length) {
    addTab();
    return;
  }
  const next = state.tabs[Math.max(0, idx - 1)];
  state.activeId = next.id;
  setActiveContent(next.content, next.view);
  renderTabs();
  updateStatus();
  schedulePersist();
}

function adoptDetachedTab(payload) {
  if (!payload) return;
  const empty = state.tabs.length === 1 && !state.tabs[0].filePath && !state.tabs[0].content;
  const data = {
    title: payload.title,
    filePath: payload.filePath,
    content: payload.content || "",
    diskContent: payload.diskContent ?? payload.content ?? "",
    encoding: payload.encoding,
    lineEnding: payload.lineEnding,
    view: payload.view,
    dirty: payload.dirty,
  };
  if (empty) {
    Object.assign(state.tabs[0], createTab(data), { id: state.tabs[0].id });
    state.activeId = state.tabs[0].id;
    if (!state.settings.formatting) state.tabs[0].view = "syntax";
    setActiveContent(state.tabs[0].content, state.tabs[0].view);
    renderTabs();
    updateStatus();
  } else {
    addTab(data);
  }
}

function initEditor() {
  rich = createRichEditor($("formatted-editor"), {
    onUpdate: () => { markDirty(); updateStatus(); },
    onSelection: updateStatus,
  });
}

async function boot() {
  if (!api) return;
  initEditor();
  bindUi();
  const queuedTabs = [];
  const queuedFiles = [];
  let ready = false;
  api.onOpenDetachedTab?.((tab) => {
    if (ready) adoptDetachedTab(tab);
    else queuedTabs.push(tab);
  });
  api.onOpenExternal((filePath) => {
    if (ready) api.readFile(filePath).then(openPayload);
    else queuedFiles.push(filePath);
  });
  api.onSystemTheme(() => {
    if (state.settings.theme === "system") applyTheme();
  });
  await restore();
  ready = true;
  for (const tab of queuedTabs) adoptDetachedTab(tab);
  for (const filePath of queuedFiles) await openPayload(await api.readFile(filePath));
  api.onCloseRequest?.(handleWindowClose);
}

async function handleWindowClose() {
  flushActive();
  if (detailTaskId) flushTaskDetail();
  clearTimeout(tasksTimer);
  persistSession();
  await persistTasks();
  if (state.settings.startup !== "session") {
    for (const tab of [...state.tabs]) {
      if (!isDirty(tab)) continue;
      if (!tab.filePath && !tab.content) continue;
      const choice = await api.unsavedDialog(tab.title);
      if (choice === "cancel") return;
      if (choice === "save") {
        const ok = await saveTab(tab, !tab.filePath);
        if (!ok) return;
      }
    }
  }
  persistSession();
  await api.allowClose();
}

boot();
