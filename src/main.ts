import "@xterm/xterm/css/xterm.css";
import "./styles.css";
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
import { SftpPanel } from "./sftp";
import { settings, TerminalTab, type Credentials } from "./terminal";
import { knownHostsDialog, netToolsDialog, tunnelsDialog } from "./tools";
import { confirmDialog, errMsg, field, h, modal, promptDialog, toast } from "./ui";

// ---------------------------------------------------------------- layout

const tabs: TerminalTab[] = [];
let active: TerminalTab | null = null;

const tabBar = h("nav", { class: "tabbar" });
const workspace = h("section", { class: "workspace" });
const home = h("div", { class: "home" });
const sessionList = h("div", { class: "session-list" });
const sftp = new SftpPanel();
const monitor = h("div", { class: "monitor" });
const sidebar = h("aside", { class: "sidebar" });
const sideTabs = { sessions: sessionList, sftp: sftp.el };
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
  toolbarBtn("⇄", "Tunnel", () => tunnelsDialog(active?.connId ?? null, active?.title ?? "")),
  toolbarBtn("🛠", "Tools", () => netToolsDialog()),
  toolbarBtn("⚙", "Settings", () => settingsDialog()),
);

const sideSwitch = h(
  "div",
  { class: "side-switch" },
  h("button", { type: "button", "data-mode": "sessions", onclick: () => showSide("sessions") }, "Sessions"),
  h("button", { type: "button", "data-mode": "sftp", onclick: () => showSide("sftp") }, "SFTP"),
);
sidebar.append(sideSwitch, sessionList, sftp.el);

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
      const on = mod && active?.modifiers[mod];
      return h(
        "button",
        {
          type: "button",
          class: on ? "key on" : "key",
          // Keep focus in the terminal so the soft keyboard stays open.
          onmousedown: (e: Event) => e.preventDefault(),
          onclick: () => {
            if (!active) return;
            if (mod) {
              active.modifiers[mod] = !active.modifiers[mod];
              renderExtraKeys();
            } else {
              active.sendKey(seq);
            }
            active.focus();
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
    active?.send(text);
  } catch {
    const text = await promptDialog("Paste", "Tempel teks di sini");
    if (text) active?.send(text);
  }
  active?.focus();
}

document.querySelector("#app")!.append(
  toolbar,
  h("div", { class: "main" }, sidebar, scrim, h("div", { class: "center" }, tabBar, workspace, monitor, extraKeys)),
);
workspace.append(home);

// ---------------------------------------------------------------- sidebar

function toggleSidebar(open?: boolean) {
  document.body.classList.toggle("side-open", open ?? !document.body.classList.contains("side-open"));
  setTimeout(() => active?.refit(), 250);
}

function showSide(mode: keyof typeof sideTabs, open = false) {
  sideMode = mode;
  for (const [k, el] of Object.entries(sideTabs)) el.hidden = k !== mode;
  sideSwitch.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
  if (mode === "sftp") sftp.setConnection(active?.state === "connected" ? active.connId : null);
  if (open) toggleSidebar(true);
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
        h("button", { class: "btn", type: "button", onclick: () => netToolsDialog() }, "🛠 Network tools"),
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
  const homeTab = h(
    "button",
    { type: "button", class: active ? "tab" : "tab on", onclick: () => activate(null) },
    "⌂",
  );
  tabBar.replaceChildren(
    homeTab,
    ...tabs.map((t) =>
      h(
        "div",
        { class: `tab ${t === active ? "on" : ""} ${t.state}`, style: `--c:${t.profile.color}`, onclick: () => activate(t) },
        h("span", { class: "dot" }),
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

function activate(t: TerminalTab | null) {
  active = t;
  home.hidden = !!t;
  for (const tab of tabs) tab.el.hidden = tab !== t;
  extraKeys.hidden = !t;
  renderTabs();
  renderExtraKeys();
  renderReconnect();
  if (sideMode === "sftp") showSide("sftp");
  updateMonitor();
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
  if (active?.state === "closed") {
    const t = active;
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
      updateMonitor();
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

function closeTab(t: TerminalTab) {
  const i = tabs.indexOf(t);
  if (i < 0) return;
  tabs.splice(i, 1);
  t.dispose();
  activate(tabs[Math.min(i, tabs.length - 1)] ?? null);
}

// ---------------------------------------------------------------- remote monitor

// Like MobaXterm's remote-monitoring bar: load, RAM, disk and uptime of the active host.
const MONITOR_CMD =
  "cut -d' ' -f1-3 /proc/loadavg; free -m | awk '/^Mem:/{print $3\"/\"$2\" MB\"}'; " +
  "df -h / | awk 'NR==2{print $3\"/\"$2\" (\"$5\")\"}'; uptime -p 2>/dev/null || uptime";
let monitorEnabled = localStorage.getItem("monitor") !== "off";
let monitorBusy = false;

async function updateMonitor() {
  const t = active;
  if (!monitorEnabled || !t || t.state !== "connected" || !t.connId) {
    monitor.hidden = true;
    return;
  }
  monitor.hidden = false;
  if (monitorBusy) return;
  monitorBusy = true;
  try {
    const res = await api.sshExec(t.connId, MONITOR_CMD);
    if (t !== active) return;
    const [load, mem, disk, up] = res.stdout.split("\n");
    const item = (k: string, v?: string) => (v ? h("span", {}, h("b", {}, k), v) : null);
    const items = [
      item("CPU ", load),
      item("RAM ", mem),
      item("Disk ", disk),
      item("⏱ ", up?.replace(/^up /, "")),
    ];
    monitor.replaceChildren(...items.filter((x): x is HTMLSpanElement => !!x));
  } catch {
    monitor.replaceChildren(h("span", { class: "muted" }, "monitor tidak tersedia"));
  } finally {
    monitorBusy = false;
  }
}
setInterval(updateMonitor, 10_000);

// ---------------------------------------------------------------- settings

async function settingsDialog() {
  const font = h("input", { type: "number", min: "8", max: "32", value: String(settings.fontSize) });
  const mon = h("input", { type: "checkbox", checked: monitorEnabled });
  const body = h(
    "div",
    { class: "form" },
    field("Ukuran font terminal", font),
    h("label", { class: "check" }, mon, "Tampilkan monitor server (CPU/RAM/Disk)"),
    h("button", { class: "btn", type: "button", onclick: () => knownHostsDialog() }, "Kelola known hosts…"),
    h("p", { class: "muted" }, "BasTerminal v0.1.0 — github.com/bastronika/basterminal"),
  );
  const res = await modal("Settings", body, [
    { label: "Batal", value: "cancel" },
    { label: "Simpan", value: "save", primary: true },
  ]);
  if (res !== "save") return;
  settings.fontSize = Math.min(32, Math.max(8, Number(font.value) || 14));
  localStorage.setItem("fontSize", String(settings.fontSize));
  tabs.forEach((t) => t.setFontSize(settings.fontSize));
  monitorEnabled = mon.checked;
  localStorage.setItem("monitor", monitorEnabled ? "on" : "off");
  updateMonitor();
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
