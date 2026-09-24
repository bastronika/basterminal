import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { api } from "./api";
import {
  deleteProfile,
  editProfileDialog,
  getProfiles,
  loadProfiles,
  newProfile,
  onProfilesChanged,
  upsertProfile,
  type Profile,
} from "./profiles";
import type { EditorTab } from "./editor";
import { SftpPanel } from "./sftp";
import { settings, TerminalTab, type Credentials } from "./terminal";
import { MonitorController } from "./monitor";
import { createNetToolsPage } from "./nettools";
import { knownHostsDialog, tunnelsDialog } from "./tools";
import { confirmDialog, errMsg, field, h, modal, promptDialog, toast } from "./ui";

// ---------------------------------------------------------------- layout

type Tab = TerminalTab | EditorTab;
const tabs: Tab[] = [];
let active: Tab | null = null;
// The editor (CodeMirror) is loaded on first use, so tabs are told apart by `kind`.
const isEditor = (t: Tab | null): t is EditorTab => t?.kind === "editor";
/** The active tab when it is a terminal. */
const term = () => (active instanceof TerminalTab ? active : null);
/** The SSH session behind the active tab (an editor's session included). */
const session = () => (isEditor(active) ? active.session : term());

const tabBar = h("nav", { class: "tabbar" });
const workspace = h("section", { class: "workspace" });
const home = h("div", { class: "home" });
const sessionList = h("div", { class: "session-list" });
const sftp = new SftpPanel((path) => openEditor(path));
const monitor = new MonitorController(() => showSide("monitor", true));
let toolsPage: HTMLElement | null = null;
/** What the workspace shows when no terminal tab is active. */
let page: "home" | "tools" = "home";
const sidebar = h("aside", { class: "sidebar" });
const sideTabs = { sessions: sessionList, sftp: sftp.el, monitor: monitor.panel };
let sideMode: keyof typeof sideTabs = "sessions";

const toolbarBtn = (icon: string, label: string, onclick: () => void) =>
  h("button", { class: "tool", type: "button", onclick, title: label }, h("span", { class: "ic" }, icon), h("span", { class: "lbl" }, label));

const toolbar = h(
  "header",
  { class: "toolbar" },
  h("button", { class: "tool menu", type: "button", title: "Panel", onclick: () => toggleSidebar() }, h("span", { class: "ic" }, "☰")),
  h("div", { class: "brand" }, "Bas", h("b", {}, "Terminal")),
  toolbarBtn("＋", "Session", () => createSession()),
  toolbarBtn("⚡", "Quick", () => quickConnect()),
  toolbarBtn("🗂", "SFTP", () => showSide("sftp", true)),
  toolbarBtn("📊", "Monitor", () => showSide("monitor", true)),
  toolbarBtn("⇄", "Tunnel", () => tunnelsDialog(session()?.connId ?? null, session()?.title ?? "")),
  toolbarBtn("🛠", "Tools", () => openTools()),
  toolbarBtn("⚙", "Settings", () => settingsDialog()),
);

const sideSwitch = h(
  "div",
  { class: "side-switch" },
  h("button", { type: "button", "data-mode": "sessions", onclick: () => showSide("sessions") }, "Sessions"),
  h("button", { type: "button", "data-mode": "sftp", onclick: () => showSide("sftp") }, "SFTP"),
  h("button", { type: "button", "data-mode": "monitor", onclick: () => showSide("monitor") }, "Monitor"),
);
sidebar.append(sideSwitch, sessionList, sftp.el, monitor.panel);

const scrim = h("div", { class: "scrim", onclick: () => toggleSidebar(false) });

// ---------------------------------------------------------------- extra keys

const KEYS: [string, string][] = [
  ["ESC", "\x1b"],
  ["TAB", "\t"],
  ["CTRL", ""],
  ["ALT", ""],
  ["↑", "\x1b[A"],
  ["↓", "\x1b[B"],
  ["←", "\x1b[D"],
  ["→", "\x1b[C"],
  ["HOME", "\x1b[H"],
  ["END", "\x1b[F"],
  ["PGUP", "\x1b[5~"],
  ["PGDN", "\x1b[6~"],
  ["|", "|"],
  ["/", "/"],
  ["-", "-"],
  ["~", "~"],
  [":", ":"],
  ["F1", "\x1bOP"],
  ["F2", "\x1bOQ"],
  ["F3", "\x1bOR"],
  ["F4", "\x1bOS"],
  ["F5", "\x1b[15~"],
  ["F10", "\x1b[21~"],
];

const extraKeys = h("div", { class: "extra-keys" });
function renderExtraKeys() {
  extraKeys.replaceChildren(
    ...KEYS.map(([label, seq]) => {
      const mod = label === "CTRL" ? "ctrl" : label === "ALT" ? "alt" : null;
      const on = mod && term()?.modifiers[mod];
      return h(
        "button",
        {
          type: "button",
          class: on ? "key on" : "key",
          // Keep focus in the terminal so the soft keyboard stays open.
          onmousedown: (e: Event) => e.preventDefault(),
          onclick: () => {
            const t = term();
            if (!t) return;
            if (mod) {
              t.modifiers[mod] = !t.modifiers[mod];
              renderExtraKeys();
            } else {
              t.sendKey(seq);
            }
            t.focus();
          },
        },
        label,
      );
    }),
    h("button", { type: "button", class: "key", onclick: () => pasteClipboard() }, "PASTE"),
  );
}

async function pasteClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    term()?.send(text);
  } catch {
    const text = await promptDialog("Paste", "Tempel teks di sini");
    if (text) term()?.send(text);
  }
  active?.focus();
}

document.querySelector("#app")!.append(
  toolbar,
  h("div", { class: "main" }, sidebar, scrim, h("div", { class: "center" }, tabBar, workspace, monitor.bar, extraKeys)),
);
workspace.append(home);

// ---------------------------------------------------------------- sidebar

function toggleSidebar(open?: boolean) {
  document.body.classList.toggle("side-open", open ?? !document.body.classList.contains("side-open"));
  syncMonitor();
  setTimeout(() => active?.refit(), 250);
}

/** Points the monitor at the active connection and tells it whether its panel is on screen. */
function syncMonitor() {
  const s = session();
  monitor.setActive(s?.state === "connected" ? s.connId : null);
  monitor.setPanelVisible(sideMode === "monitor" && document.body.classList.contains("side-open"));
}

function showSide(mode: keyof typeof sideTabs, open = false) {
  sideMode = mode;
  for (const [k, el] of Object.entries(sideTabs)) el.hidden = k !== mode;
  sideSwitch.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
  const s = session();
  if (mode === "sftp") sftp.setConnection(s?.state === "connected" ? s.connId : null);
  if (open) toggleSidebar(true);
  else syncMonitor();
}

function sessionCard(p: Profile, big = false) {
  return h(
    "div",
    { class: big ? "session-card big" : "session-card", style: `--c:${p.color}`, onclick: () => openSession(p) },
    h("span", { class: "dot" }),
    h(
      "div",
      { class: "session-text" },
      h("strong", {}, p.name),
      h("small", {}, `${p.username}@${p.host}${p.port !== 22 ? ":" + p.port : ""}`),
    ),
    h(
      "button",
      {
        class: "icon-btn small",
        type: "button",
        title: "Edit",
        onclick: (e: Event) => {
          e.stopPropagation();
          sessionMenu(p);
        },
      },
      "⋮",
    ),
  );
}

function renderSessions() {
  const profiles = getProfiles();
  const groups = new Map<string, Profile[]>();
  for (const p of [...profiles].sort((a, b) => a.name.localeCompare(b.name))) {
    const g = p.group || "Sesi";
    groups.set(g, [...(groups.get(g) ?? []), p]);
  }
  sessionList.replaceChildren(
    h("button", { class: "btn primary block", type: "button", onclick: () => createSession() }, "＋ Sesi baru"),
    ...[...groups].flatMap(([g, ps]) => [h("div", { class: "group-title" }, g), ...ps.map((p) => sessionCard(p))]),
  );

  home.replaceChildren(
    h(
      "div",
      { class: "hero" },
      h("h1", {}, "Bas", h("b", {}, "Terminal")),
      h("p", { class: "muted" }, "SSH · SFTP · Tunnel · Network tools — MobaXterm di saku Anda."),
      h(
        "div",
        { class: "hero-actions" },
        h("button", { class: "btn primary", type: "button", onclick: () => createSession() }, "＋ Sesi baru"),
        h("button", { class: "btn", type: "button", onclick: () => quickConnect() }, "⚡ Quick connect"),
        h("button", { class: "btn", type: "button", onclick: () => openTools() }, "🛠 Network tools"),
      ),
    ),
    profiles.length
      ? h("div", { class: "session-grid" }, ...profiles.map((p) => sessionCard(p, true)))
      : h("p", { class: "muted center-text" }, "Belum ada sesi tersimpan."),
  );
}

async function sessionMenu(p: Profile) {
  const res = await modal(p.name, h("p", { class: "muted" }, `${p.username}@${p.host}:${p.port}`), [
    { label: "Connect", value: "connect", primary: true },
    { label: "Edit", value: "edit" },
    { label: "Duplikat", value: "dup" },
    { label: "Hapus", value: "delete", danger: true },
    { label: "Tutup", value: "close" },
  ]);
  if (res === "connect") openSession(p);
  if (res === "edit") {
    const edited = await editProfileDialog(p);
    if (edited) await upsertProfile(edited);
  }
  if (res === "dup") await upsertProfile({ ...p, id: crypto.randomUUID(), name: `${p.name} (copy)` });
  if (res === "delete" && (await confirmDialog("Hapus sesi", `Hapus sesi ${p.name}?`, true))) await deleteProfile(p.id);
}

async function createSession() {
  const p = await editProfileDialog(newProfile(), "Sesi SSH baru");
  if (!p) return;
  await upsertProfile(p);
  openSession(p);
}

async function quickConnect() {
  const target = await promptDialog("Quick connect", "user@host[:port]", "", "text");
  const m = target?.trim().match(/^(?:([^@\s]+)@)?([^:\s]+)(?::(\d+))?$/);
  if (!m) return;
  openSession({ ...newProfile(), name: target!.trim(), username: m[1] ?? "root", host: m[2], port: Number(m[3] ?? 22) });
}

// ---------------------------------------------------------------- tabs

function renderTabs() {
  const pageTab = (p: typeof page, label: string, title: string) =>
    h("button", { type: "button", class: !active && page === p ? "tab on" : "tab", title, onclick: () => ((page = p), activate(null)) }, label);
  tabBar.replaceChildren(
    pageTab("home", "⌂", "Beranda"),
    pageTab("tools", "🛠", "Network tools"),
    ...tabs.map((t) =>
      h(
        "div",
        {
          class: `tab ${t === active ? "on" : ""} ${isEditor(t) ? `editor ${t.state}` : t.state}`,
          style: `--c:${isEditor(t) ? t.color : t.profile.color}`,
          title: isEditor(t) ? `${t.path} — ${t.session.title}` : t.title,
          onclick: () => activate(t),
        },
        isEditor(t) ? h("span", { class: "tab-icon" }, "📝") : h("span", { class: "dot" }),
        h("span", { class: "tab-title" }, t.title),
        h(
          "button",
          {
            type: "button",
            class: "tab-close",
            title: "Tutup",
            onclick: (e: Event) => {
              e.stopPropagation();
              closeTab(t);
            },
          },
          "×",
        ),
      ),
    ),
  );
}

function openTools() {
  toggleSidebar(false);
  page = "tools";
  activate(null);
}

function activate(t: Tab | null) {
  active = t;
  if (!t && page === "tools" && !toolsPage) {
    toolsPage = createNetToolsPage();
    workspace.append(toolsPage);
  }
  home.hidden = !!t || page !== "home";
  if (toolsPage) toolsPage.hidden = !!t || page !== "tools";
  for (const tab of tabs) tab.el.hidden = tab !== t;
  extraKeys.hidden = !(t instanceof TerminalTab);
  renderTabs();
  renderExtraKeys();
  renderReconnect();
  if (sideMode === "sftp") showSide("sftp");
  syncMonitor();
  if (t) {
    requestAnimationFrame(() => {
      t.refit();
      t.focus();
    });
  }
}

const reconnectBar = h("div", { class: "reconnect" });
function renderReconnect() {
  reconnectBar.replaceChildren();
  const t = term();
  if (t?.state === "closed") {
    reconnectBar.append(
      h("span", {}, "Sesi terputus"),
      h("button", { class: "btn primary small", type: "button", onclick: () => connectTab(t) }, "Reconnect"),
      h("button", { class: "btn small", type: "button", onclick: () => closeTab(t) }, "Tutup tab"),
    );
  }
  reconnectBar.hidden = !reconnectBar.childElementCount;
}
workspace.append(reconnectBar);

async function credentialsFor(p: Profile): Promise<Credentials | null> {
  if (p.authType === "key") {
    return { privateKey: p.privateKey, passphrase: p.passphrase, password: p.savePassword ? p.password : undefined };
  }
  if (p.savePassword && p.password) return { password: p.password };
  const pw = await promptDialog(`Password untuk ${p.username}@${p.host}`, "Password", "", "password");
  return pw === null ? null : { password: pw };
}

async function connectTab(t: TerminalTab) {
  const creds = await credentialsFor(t.profile);
  if (!creds) return;
  if (t.connId) await t.disconnect();
  try {
    await t.connect(creds);
  } catch (e) {
    toast(errMsg(e), "error");
  }
}

async function openSession(p: Profile) {
  toggleSidebar(false);
  const t = new TerminalTab(p);
  tabs.push(t);
  workspace.append(t.el);
  t.onStateChange = () => {
    renderTabs();
    if (t === active) {
      renderReconnect();
      if (sideMode === "sftp") showSide("sftp");
      syncMonitor();
    }
  };
  t.onModifiersUsed = () => renderExtraKeys();
  activate(t);
  t.mount();
  const creds = await credentialsFor(p);
  if (!creds) return closeTab(t);
  try {
    await t.connect(creds);
  } catch (e) {
    toast(errMsg(e), "error");
  }
}

async function closeTab(t: Tab) {
  // Closing a terminal also closes the editors that use its connection.
  const closing = t instanceof TerminalTab ? [...tabs.filter((x) => isEditor(x) && x.session === t), t] : [t];
  for (const x of closing) {
    if (isEditor(x)) {
      if (x !== active && x.dirty) activate(x);
      if (!(await x.confirmClose())) return;
    }
  }
  const i = tabs.indexOf(t);
  for (const x of closing) {
    const j = tabs.indexOf(x);
    if (j < 0) continue;
    tabs.splice(j, 1);
    if (x instanceof TerminalTab && x.connId) monitor.forget(x.connId);
    x.dispose();
  }
  // Editors sit right after their terminal, so the next tab lands on index i.
  activate(tabs[Math.min(i, tabs.length - 1)] ?? null);
}

// ---------------------------------------------------------------- editor

async function openEditor(path: string) {
  const s = session();
  if (!s || s.state !== "connected") return toast("Buka sesi SSH dulu", "error");
  const existing = tabs.find((x) => isEditor(x) && x.session === s && x.path === path);
  if (existing) return activate(existing);
  toggleSidebar(false);
  toast(`Membuka ${path.split("/").pop()}…`);
  try {
    const { EditorTab } = await import("./editor");
    const ed = await EditorTab.open(s, path);
    ed.onChange = () => renderTabs();
    tabs.splice(tabs.indexOf(s) + 1 + tabs.filter((x) => isEditor(x) && x.session === s).length, 0, ed);
    workspace.append(ed.el);
    activate(ed);
  } catch (e) {
    toast(errMsg(e), "error");
  }
}

// ---------------------------------------------------------------- settings

async function settingsDialog() {
  const font = h("input", { type: "number", min: "8", max: "32", value: String(settings.fontSize) });
  const mon = h("input", { type: "checkbox", checked: monitor.barEnabled });
  const about = h("p", { class: "muted" }, "BasTerminal — github.com/bastronika/basterminal");
  getVersion().then((v) => (about.textContent = `BasTerminal v${v} — github.com/bastronika/basterminal`)).catch(() => {});
  const body = h(
    "div",
    { class: "form" },
    field("Ukuran font terminal", font),
    h("label", { class: "check" }, mon, "Tampilkan bar monitor server di bawah terminal"),
    h("button", { class: "btn", type: "button", onclick: () => knownHostsDialog() }, "Kelola known hosts…"),
    about,
  );
  const res = await modal("Settings", body, [
    { label: "Batal", value: "cancel" },
    { label: "Simpan", value: "save", primary: true },
  ]);
  if (res !== "save") return;
  settings.fontSize = Math.min(32, Math.max(8, Number(font.value) || 14));
  localStorage.setItem("fontSize", String(settings.fontSize));
  tabs.forEach((t) => t instanceof TerminalTab && t.setFontSize(settings.fontSize));
  monitor.setBarEnabled(mon.checked);
}

// ---------------------------------------------------------------- host key prompt

interface HostKeyPrompt {
  requestId: string;
  host: string;
  algorithm: string;
  fingerprint: string;
  previous: string | null;
}

listen<HostKeyPrompt>("hostkey-prompt", async ({ payload }) => {
  const changed = !!payload.previous;
  const body = h(
    "div",
    {},
    changed
      ? h(
          "p",
          { class: "error" },
          "⚠ PERINGATAN: host key server BERUBAH! Bisa jadi server diinstal ulang, atau ada serangan man-in-the-middle.",
        )
      : h("p", {}, "Host ini belum dikenal. Pastikan fingerprint sesuai sebelum mempercayainya."),
    h("p", {}, h("strong", {}, payload.host)),
    h("code", { class: "fp" }, `${payload.algorithm} ${payload.fingerprint}`),
    changed ? h("p", { class: "muted" }, `Sebelumnya: ${payload.previous}`) : null,
  );
  const res = await modal(changed ? "Host key berubah!" : "Host baru", body, [
    { label: "Tolak", value: "reject" },
    changed
      ? { label: "Tetap percaya", value: "accept", danger: true }
      : { label: "Percaya & lanjut", value: "accept", primary: true },
  ]);
  await api.hostkeyDecide(payload.requestId, res === "accept");
});

// ---------------------------------------------------------------- boot

onProfilesChanged(renderSessions);
showSide("sessions");
activate(null);
loadProfiles().catch((e) => toast(errMsg(e), "error"));
if (window.matchMedia("(min-width: 900px)").matches) document.body.classList.add("side-open");
