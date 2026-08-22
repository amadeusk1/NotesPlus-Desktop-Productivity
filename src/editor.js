import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import MarkdownIt from "markdown-it";
import TurndownService from "turndown";

const md = new MarkdownIt({
  html: false,
  linkify: false,
  breaks: false,
  typographer: false,
});
md.disable(["code", "fence", "blockquote", "hr", "image", "autolink", "html_inline", "html_block", "reference"]);

const turndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
  strongDelimiter: "**",
});
turndown.addRule("strikethrough", {
  filter: ["del", "s", "strike"],
  replacement: (content) => `~~${content}~~`,
});

export function markdownToHtml(markdown) {
  const source = markdown ?? "";
  if (!source.trim()) return "<p></p>";
  return md.render(source);
}

export function htmlToMarkdown(html) {
  return turndown.turndown(html || "").replace(/\r\n/g, "\n");
}

export function createRichEditor(element, { onUpdate, onSelection }) {
  const editor = new Editor({
    element,
    extensions: [
      StarterKit.configure({
        code: false,
        codeBlock: false,
        blockquote: false,
        horizontalRule: false,
        heading: { levels: [1, 2, 3, 4, 5, 6] },
      }),
      Link.configure({
        openOnClick: true,
        autolink: false,
        linkOnPaste: true,
      }),
    ],
    content: "<p></p>",
    editorProps: {
      attributes: { spellcheck: "true" },
    },
    onUpdate: () => onUpdate?.(),
    onSelectionUpdate: () => onSelection?.(),
    onFocus: () => onSelection?.(),
  });

  return editor;
}

export function wrapSyntax(text, start, end, before, after = before) {
  const selected = text.slice(start, end) || "text";
  const next = text.slice(0, start) + before + selected + after + text.slice(end);
  return {
    text: next,
    selectStart: start + before.length,
    selectEnd: start + before.length + selected.length,
  };
}

export function applyLinePrefix(text, start, end, prefix) {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  let lineEnd = text.indexOf("\n", end);
  if (lineEnd === -1) lineEnd = text.length;
  const block = text.slice(lineStart, lineEnd);
  const lines = block.split("\n").map((line) => {
    const stripped = line.replace(/^(\s*)(#{1,6}\s+|[-*]\s+|\d+\.\s+)/, "$1");
    if (prefix === "") return stripped;
    if (prefix === "- ") return `${prefix}${stripped || ""}`;
    if (prefix === "1. ") return `${prefix}${stripped || ""}`;
    return `${prefix}${stripped}`;
  });
  const next = text.slice(0, lineStart) + lines.join("\n") + text.slice(lineEnd);
  return { text: next, selectStart: lineStart, selectEnd: lineStart + lines.join("\n").length };
}

export function stripMarkdown(text, start, end) {
  const from = start === end ? 0 : start;
  const to = start === end ? text.length : end;
  const chunk = text.slice(from, to)
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*]\s+/gm, "")
    .replace(/^\d+\.\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/\[(.+?)\]\((.+?)\)/g, "$1");
  return {
    text: text.slice(0, from) + chunk + text.slice(to),
    selectStart: from,
    selectEnd: from + chunk.length,
  };
}

export function cursorFromIndex(text, index) {
  const safe = Math.max(0, Math.min(index, text.length));
  const upto = text.slice(0, safe);
  const lines = upto.split("\n");
  return { line: lines.length, col: lines[lines.length - 1].length + 1 };
}

export function indexFromLineCol(text, line, col) {
  const lines = text.split("\n");
  const l = Math.max(1, Math.min(line, lines.length)) - 1;
  const c = Math.max(1, Math.min(col, lines[l].length + 1)) - 1;
  let index = 0;
  for (let i = 0; i < l; i += 1) index += lines[i].length + 1;
  return index + c;
}

export function findNext(text, query, from, { matchCase, regex, wrap }) {
  if (!query) return null;
  try {
    if (regex) {
      const flags = matchCase ? "g" : "gi";
      const re = new RegExp(query, flags);
      re.lastIndex = from;
      const hit = re.exec(text);
      if (hit) return { start: hit.index, end: hit.index + hit[0].length };
      if (wrap) {
        re.lastIndex = 0;
        const again = re.exec(text.slice(0, from));
        if (again) return { start: again.index, end: again.index + again[0].length };
      }
      return null;
    }
    const hay = matchCase ? text : text.toLowerCase();
    const needle = matchCase ? query : query.toLowerCase();
    let start = hay.indexOf(needle, from);
    if (start === -1 && wrap) start = hay.indexOf(needle, 0);
    if (start === -1) return null;
    return { start, end: start + query.length };
  } catch {
    return null;
  }
}

export function findPrev(text, query, from, { matchCase, regex, wrap }) {
  if (!query) return null;
  const slice = text.slice(0, from);
  if (regex) {
    try {
      const flags = matchCase ? "g" : "gi";
      const re = new RegExp(query, flags);
      let last = null;
      let m = re.exec(slice);
      while (m) {
        last = { start: m.index, end: m.index + m[0].length };
        m = re.exec(slice);
      }
      if (last) return last;
      if (wrap) {
        last = null;
        m = re.exec(text);
        while (m) {
          last = { start: m.index, end: m.index + m[0].length };
          m = re.exec(text);
        }
        return last;
      }
    } catch {
      return null;
    }
    return null;
  }
  const hay = matchCase ? slice : slice.toLowerCase();
  const needle = matchCase ? query : query.toLowerCase();
  let start = hay.lastIndexOf(needle);
  if (start === -1 && wrap) {
    const all = matchCase ? text : text.toLowerCase();
    start = all.lastIndexOf(needle);
  }
  if (start === -1) return null;
  return { start, end: start + query.length };
}
