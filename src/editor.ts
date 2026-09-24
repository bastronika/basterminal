// Remote text editor (like MobaXterm's MobaTextEditor): opens a file over
// SFTP in its own workspace tab, with syntax highlighting, search/replace
// and safe saving (conflict check, line endings, BOM and encoding kept).
import { defaultKeymap, history, historyKeymap, indentLess, indentMore, indentWithTab, redo, undo } from "@codemirror/commands";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  StreamLanguage,
  syntaxHighlighting,
  defaultHighlightStyle,
  type StreamParser,
} from "@codemirror/language";
import { highlightSelectionMatches, openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { api, b64ToBytes, bytesToB64 } from "./api";
import type { TerminalTab } from "./terminal";
import { confirmDialog, errMsg, formatSize, h, modal, promptDialog, toast } from "./ui";

/** Larger files are better downloaded; a phone editor would struggle. */
export const MAX_EDIT_BYTES = 5 * 1024 * 1024;

// ------------------------------------------------------------------ languages

type LangLoader = () => Promise<Extension>;
const legacy = (load: () => Promise<StreamParser<unknown>>): LangLoader => async () => StreamLanguage.define(await load());

/** Picks a language by file name; loaders are dynamic imports so each mode
 *  is only downloaded into the webview when a file needs it. */
export function languageFor(path: string): { name: string; load: LangLoader } | null {
  const base = path.split("/").pop()!.toLowerCase();
  const ext = base.includes(".") ? base.split(".").pop()! : "";
  const L = (name: string, load: LangLoader) => ({ name, load });
  if (base === "dockerfile" || base.startsWith("dockerfile.") || ext === "dockerfile")
    return L("Dockerfile", legacy(async () => (await import("@codemirror/legacy-modes/mode/dockerfile")).dockerFile));
  if (/nginx/.test(path) && (ext === "conf" || !ext) || base === "nginx.conf")
    return L("nginx", legacy(async () => (await import("@codemirror/legacy-modes/mode/nginx")).nginx));
  if ([".bashrc", ".bash_profile", ".profile", ".zshrc", "profile", "bashrc", "crontab"].includes(base) || ["sh", "bash", "zsh", "ksh"].includes(ext))
    return L("Shell", legacy(async () => (await import("@codemirror/legacy-modes/mode/shell")).shell));
  switch (ext) {
    case "py":
    case "pyw":
      return L("Python", async () => (await import("@codemirror/lang-python")).python());
    case "js":
    case "mjs":
    case "cjs":
    case "jsx":
      return L("JavaScript", async () => (await import("@codemirror/lang-javascript")).javascript({ jsx: ext === "jsx" }));
    case "ts":
    case "tsx":
      return L("TypeScript", async () => (await import("@codemirror/lang-javascript")).javascript({ typescript: true, jsx: ext === "tsx" }));
    case "json":
    case "jsonc":
      return L("JSON", async () => (await import("@codemirror/lang-json")).json());
    case "yml":
    case "yaml":
      return L("YAML", async () => (await import("@codemirror/lang-yaml")).yaml());
    case "xml":
    case "svg":
    case "plist":
    case "xsd":
      return L("XML", async () => (await import("@codemirror/lang-xml")).xml());
    case "html":
    case "htm":
    case "vue":
      return L("HTML", async () => (await import("@codemirror/lang-html")).html());
    case "css":
    case "scss":
    case "less":
      return L("CSS", async () => (await import("@codemirror/lang-css")).css());
    case "sql":
      return L("SQL", async () => (await import("@codemirror/lang-sql")).sql());
    case "php":
      return L("PHP", async () => (await import("@codemirror/lang-php")).php());
    case "md":
    case "markdown":
      return L("Markdown", async () => (await import("@codemirror/lang-markdown")).markdown());
    case "rs":
      return L("Rust", async () => (await import("@codemirror/lang-rust")).rust());
    case "c":
    case "h":
    case "cc":
    case "cpp":
    case "hpp":
    case "ino":
      return L("C/C++", async () => (await import("@codemirror/lang-cpp")).cpp());
    case "java":
    case "kt":
      return L("Java", async () => (await import("@codemirror/lang-java")).java());
    case "go":
      return L("Go", async () => (await import("@codemirror/lang-go")).go());
    case "toml":
      return L("TOML", legacy(async () => (await import("@codemirror/legacy-modes/mode/toml")).toml));
    case "ini":
    case "cfg":
    case "conf":
    case "cnf":
    case "properties":
    case "env":
    case "service":
    case "timer":
    case "socket":
      return L("INI/Config", legacy(async () => (await import("@codemirror/legacy-modes/mode/properties")).properties));
    case "lua":
      return L("Lua", legacy(async () => (await import("@codemirror/legacy-modes/mode/lua")).lua));
    case "pl":
    case "pm":
      return L("Perl", legacy(async () => (await import("@codemirror/legacy-modes/mode/perl")).perl));
    case "rb":
      return L("Ruby", legacy(async () => (await import("@codemirror/legacy-modes/mode/ruby")).ruby));
    case "diff":
    case "patch":
      return L("Diff", legacy(async () => (await import("@codemirror/legacy-modes/mode/diff")).diff));
    case "ps1":
    case "psm1":
      return L("PowerShell", legacy(async () => (await import("@codemirror/legacy-modes/mode/powershell")).powerShell));
  }
  if (base.endsWith("_config") || base === "hosts" || base === "fstab")
    return L("Config", legacy(async () => (await import("@codemirror/legacy-modes/mode/properties")).properties));
  return null;
}

// ------------------------------------------------------------------ decoding

export interface Decoded {
  text: string;
  eol: "\n" | "\r\n";
  bom: boolean;
  /** Not valid UTF-8: shown with replacement characters, read-only. */
  lossy: boolean;
}

export function isBinary(bytes: Uint8Array) {
  return bytes.subarray(0, 8192).includes(0);
}

export function decodeText(bytes: Uint8Array): Decoded {
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const body = bom ? bytes.subarray(3) : bytes;
  let text: string;
  let lossy = false;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(body);
    lossy = true;
  }
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return { text, eol: crlf > lf ? "\r\n" : "\n", bom, lossy };
}

export function encodeText(text: string, bom: boolean): Uint8Array {
  const body = new TextEncoder().encode(text);
  if (!bom) return body;
  const out = new Uint8Array(body.length + 3);
  out.set([0xef, 0xbb, 0xbf]);
  out.set(body, 3);
  return out;
}

// ------------------------------------------------------------------ editor tab

/** The path box is right-to-left so long paths truncate at the start; a
 *  leading LRM keeps the leading "/" where it belongs. */
const ltr = (path: string) => `\u200E${path}`;

/** Read-only also turns off contenteditable, so no soft keyboard pops up. */
const readOnlyExt = (ro: boolean) => [EditorState.readOnly.of(ro), EditorView.editable.of(!ro)];

const appTheme = EditorView.theme(
  {
    "&": { height: "100%", backgroundColor: "var(--bg)" },
    ".cm-scroller": { fontFamily: '"JetBrains Mono", "Fira Code", Menlo, Consolas, "DejaVu Sans Mono", monospace' },
    ".cm-gutters": { backgroundColor: "var(--bg)", borderRight: "1px solid var(--border)" },
    ".cm-panels": { backgroundColor: "var(--panel)", color: "var(--text)" },
    ".cm-panels input, .cm-panels button": { fontSize: "14px" },
    ".cm-search": { display: "flex", flexWrap: "wrap", gap: "4px", alignItems: "center" },
  },
  { dark: true },
);

export class EditorTab {
  readonly key = crypto.randomUUID();
  readonly el: HTMLDivElement;
  readonly kind = "editor";
  private view!: EditorView;
  private wrap = new Compartment();
  private fontSize = new Compartment();
  private lang = new Compartment();
  private readOnly = new Compartment();
  private savedText = "";
  private statusEl: HTMLDivElement;
  private pathEl: HTMLDivElement;
  private eol: "\n" | "\r\n" = "\n";
  private bom = false;
  private mtime: number | null = null;
  private langName = "Teks";
  private wrapOn = localStorage.getItem("editor.wrap") !== "off";
  private size = Number(localStorage.getItem("editor.fontSize")) || 14;
  saving = false;
  onChange: () => void = () => {};
  /** Asks the app to close this tab (after the dirty check). */
  onClose: () => void = () => {};

  private constructor(
    readonly session: TerminalTab,
    public path: string,
  ) {
    this.pathEl = h("div", { class: "ed-path", title: path }, ltr(path));
    this.statusEl = h("div", { class: "ed-status" });
    const btn = (label: string, title: string, fn: () => void, cls = "") =>
      h("button", { type: "button", class: `ed-btn ${cls}`, title, "aria-label": title, onmousedown: (e: Event) => e.preventDefault(), onclick: fn }, label);
    const toolbar = h(
      "div",
      { class: "ed-toolbar" },
      btn("💾 Simpan", "Simpan (Ctrl+S)", () => this.save(), "primary"),
      btn("↶", "Undo", () => undo(this.view)),
      btn("↷", "Redo", () => redo(this.view)),
      btn("🔍", "Cari & ganti (Ctrl+F)", () => openSearchPanel(this.view)),
      btn("⇥", "Indent", () => indentMore(this.view)),
      btn("⇤", "Outdent", () => indentLess(this.view)),
      btn("#", "Lompat ke baris", () => this.gotoLine()),
      btn("↩", "Word wrap", () => this.toggleWrap()),
      btn("A−", "Perkecil font", () => this.setFont(this.size - 1)),
      btn("A+", "Perbesar font", () => this.setFont(this.size + 1)),
      btn("⋯", "Lainnya", () => this.menu()),
    );
    this.el = h("div", { class: "editor-view" }, h("div", { class: "ed-head" }, this.pathEl, toolbar), h("div", { class: "ed-host" }), this.statusEl);
  }

  get name() {
    return this.path.split("/").pop() || this.path;
  }

  get dirty() {
    return this.view ? this.text() !== this.savedText : false;
  }

  get title() {
    return `${this.dirty ? "● " : ""}${this.name}`;
  }

  get color() {
    return this.session.profile.color;
  }

  get state() {
    return this.dirty ? "dirty" : "clean";
  }

  private text() {
    return this.view.state.doc.sliceString(0, this.view.state.doc.length, this.eol);
  }

  private connId() {
    const id = this.session.state === "connected" ? this.session.connId : null;
    if (!id) throw new Error(`Sesi SSH ${this.session.title} terputus — sambungkan lagi tab terminalnya`);
    return id;
  }

  /** Opens `path` from the session's server; throws with a readable message. */
  static async open(session: TerminalTab, path: string): Promise<EditorTab> {
    const tab = new EditorTab(session, path);
    await tab.load(true);
    return tab;
  }

  private async load(first: boolean) {
    const id = this.connId();
    const st = await api.sftpStat(id, this.path);
    if (st.isDir) throw new Error("Itu folder, bukan file");
    if (st.size > MAX_EDIT_BYTES) throw new Error(`File terlalu besar untuk editor (${formatSize(st.size)}, maks. ${formatSize(MAX_EDIT_BYTES)}) — gunakan Download`);
    const bytes = b64ToBytes(await api.sftpRead(id, this.path));
    if (isBinary(bytes)) throw new Error("File biner tidak bisa diedit sebagai teks");
    const dec = decodeText(bytes);
    this.eol = dec.eol;
    this.bom = dec.bom;
    this.mtime = st.mtime;
    const lang = languageFor(this.path);
    this.langName = lang?.name ?? "Teks";

    if (first) {
      this.view = new EditorView({
        parent: this.el.querySelector(".ed-host")!,
        state: EditorState.create({
          doc: dec.text,
          extensions: [
            lineNumbers(),
            highlightActiveLineGutter(),
            highlightSpecialChars(),
            history(),
            foldGutter(),
            drawSelection(),
            dropCursor(),
            EditorState.allowMultipleSelections.of(true),
            indentOnInput(),
            syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
            bracketMatching(),
            rectangularSelection(),
            crosshairCursor(),
            highlightActiveLine(),
            highlightSelectionMatches(),
            search({ top: true }),
            keymap.of([
              { key: "Mod-s", run: () => (this.save(), true), preventDefault: true },
              ...defaultKeymap,
              ...searchKeymap,
              ...historyKeymap,
              ...foldKeymap,
              indentWithTab,
            ]),
            oneDark,
            appTheme,
            this.wrap.of(this.wrapOn ? EditorView.lineWrapping : []),
            this.fontSize.of(EditorView.theme({ ".cm-content, .cm-gutters": { fontSize: `${this.size}px` } })),
            this.lang.of([]),
            this.readOnly.of(readOnlyExt(dec.lossy)),
            EditorView.updateListener.of((u) => {
              if (u.docChanged) this.onChange();
              if (u.docChanged || u.selectionSet) this.renderStatus();
            }),
          ],
        }),
      });
    } else {
      this.view.dispatch({
        changes: { from: 0, to: this.view.state.doc.length, insert: dec.text },
        effects: this.readOnly.reconfigure(readOnlyExt(dec.lossy)),
      });
    }
    this.savedText = this.text();
    if (dec.lossy) toast("File bukan UTF-8 — dibuka hanya-baca agar isinya tidak rusak", "error");
    this.renderStatus();
    this.onChange();
    lang
      ?.load()
      .then((ext) => this.view.dispatch({ effects: this.lang.reconfigure(ext) }))
      .catch(() => {});
  }

  private renderStatus() {
    if (!this.view) return;
    const st = this.view.state;
    const head = st.selection.main.head;
    const line = st.doc.lineAt(head);
    const ro = st.readOnly ? " · hanya-baca" : "";
    this.statusEl.textContent = `Ln ${line.number}, Col ${head - line.from + 1} · ${st.doc.lines} baris · ${this.langName} · ${this.eol === "\r\n" ? "CRLF" : "LF"} · UTF-8${this.bom ? " BOM" : ""}${ro}${this.dirty ? " · belum disimpan" : ""}`;
  }

  async save(): Promise<boolean> {
    if (this.saving || this.view.state.readOnly) return false;
    this.saving = true;
    try {
      const id = this.connId();
      // Refuse to silently clobber changes made on the server since we loaded.
      const st = await api.sftpStat(id, this.path).catch(() => null);
      if (st && this.mtime !== null && st.mtime !== null && st.mtime !== this.mtime) {
        const ok = await confirmDialog("File berubah di server", `${this.path} sudah diubah di server sejak dibuka. Timpa dengan versi Anda?`, true);
        if (!ok) return false;
      }
      const text = this.text();
      await api.sftpWrite(id, this.path, bytesToB64(encodeText(text, this.bom)));
      this.savedText = text;
      this.mtime = (await api.sftpStat(id, this.path).catch(() => null))?.mtime ?? null;
      toast(`Tersimpan: ${this.name}`, "ok");
      this.onChange();
      this.renderStatus();
      return true;
    } catch (e) {
      toast(errMsg(e), "error");
      return false;
    } finally {
      this.saving = false;
    }
  }

  private async gotoLine() {
    const v = await promptDialog("Lompat ke baris", `Nomor baris (1–${this.view.state.doc.lines})`, "", "number");
    const n = Number(v);
    if (!v || !Number.isInteger(n)) return;
    const line = this.view.state.doc.line(Math.max(1, Math.min(n, this.view.state.doc.lines)));
    this.view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
    this.view.focus();
  }

  private toggleWrap() {
    this.wrapOn = !this.wrapOn;
    localStorage.setItem("editor.wrap", this.wrapOn ? "on" : "off");
    this.view.dispatch({ effects: this.wrap.reconfigure(this.wrapOn ? EditorView.lineWrapping : []) });
  }

  private setFont(size: number) {
    this.size = Math.max(9, Math.min(28, size));
    localStorage.setItem("editor.fontSize", String(this.size));
    this.view.dispatch({ effects: this.fontSize.reconfigure(EditorView.theme({ ".cm-content, .cm-gutters": { fontSize: `${this.size}px` } })) });
  }

  private async menu() {
    const res = await modal(this.name, h("code", {}, this.path), [
      { label: "Simpan sebagai…", value: "saveas" },
      { label: "Muat ulang dari server", value: "reload" },
      { label: `Line ending: ${this.eol === "\r\n" ? "CRLF → LF" : "LF → CRLF"}`, value: "eol" },
      { label: "Tutup", value: "close" },
    ]);
    if (res === "saveas") {
      const target = (await promptDialog("Simpan sebagai", "Path tujuan di server", this.path))?.trim();
      if (!target || target === this.path) return;
      const exists = await api.sftpStat(this.connId(), target).then(() => true, () => false);
      if (exists && !(await confirmDialog("File sudah ada", `${target} sudah ada. Timpa?`, true))) return;
      const prev = this.path;
      this.path = target;
      this.mtime = null;
      if (await this.save()) {
        this.pathEl.textContent = ltr(target);
        this.pathEl.title = target;
        this.langName = languageFor(target)?.name ?? "Teks";
        this.onChange();
      } else this.path = prev;
    } else if (res === "reload") {
      if (this.dirty && !(await confirmDialog("Muat ulang", "Perubahan yang belum disimpan akan hilang. Lanjutkan?", true))) return;
      try {
        await this.load(false);
      } catch (e) {
        toast(errMsg(e), "error");
      }
    } else if (res === "eol") {
      this.eol = this.eol === "\r\n" ? "\n" : "\r\n";
      this.renderStatus();
      this.onChange();
    }
  }

  /** Resolves true when the tab may close (saved, or changes discarded). */
  async confirmClose(): Promise<boolean> {
    if (!this.dirty) return true;
    const res = await modal("Belum disimpan", h("p", {}, `Simpan perubahan pada ${this.name}?`), [
      { label: "Batal", value: "cancel" },
      { label: "Buang", value: "discard", danger: true },
      { label: "Simpan", value: "save", primary: true },
    ]);
    if (res === "save") return this.save();
    return res === "discard";
  }

  refit() {
    this.view?.requestMeasure();
  }

  focus() {
    this.view?.focus();
  }

  dispose() {
    this.view?.destroy();
    this.el.remove();
  }
}
