// One SSH terminal tab: xterm.js view bound to a Rust-side SSH shell.
import { Channel } from "@tauri-apps/api/core";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { api, b64ToBytes, type TermEvent } from "./api";
import type { Profile } from "./profiles";
import { h } from "./ui";

export type TabState = "connecting" | "connected" | "closed";

export interface Credentials {
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

export const settings = {
  fontSize: Number(localStorage.getItem("fontSize")) || 14,
};

const THEME = {
  background: "#0d1117",
  foreground: "#e6edf3",
  cursor: "#3fb950",
  selectionBackground: "#2f81f766",
  black: "#484f58",
  red: "#ff7b72",
  green: "#3fb950",
  yellow: "#d29922",
  blue: "#58a6ff",
  magenta: "#bc8cff",
  cyan: "#39c5cf",
  white: "#b1bac4",
  brightBlack: "#6e7681",
  brightRed: "#ffa198",
  brightGreen: "#56d364",
  brightYellow: "#e3b341",
  brightBlue: "#79c0ff",
  brightMagenta: "#d2a8ff",
  brightCyan: "#56d4dd",
  brightWhite: "#ffffff",
};

export class TerminalTab {
  readonly key = crypto.randomUUID();
  readonly el: HTMLDivElement;
  readonly term: Terminal;
  private fit = new FitAddon();
  connId: string | null = null;
  state: TabState = "connecting";
  /** Sticky modifiers toggled from the on-screen extra-keys bar. */
  modifiers = { ctrl: false, alt: false };
  onStateChange: () => void = () => {};
  onModifiersUsed: () => void = () => {};
  private resizeObserver: ResizeObserver;

  constructor(readonly profile: Profile) {
    this.el = h("div", { class: "term-view" });
    this.term = new Terminal({
      fontFamily: '"JetBrains Mono", "Fira Code", Menlo, Consolas, "DejaVu Sans Mono", monospace',
      fontSize: settings.fontSize,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
      theme: THEME,
    });
    this.term.loadAddon(this.fit);
    this.term.loadAddon(new WebLinksAddon());
    this.term.onData((d) => this.send(this.applyModifiers(d)));
    this.term.onResize(({ cols, rows }) => {
      if (this.connId && this.state === "connected") api.sshResize(this.connId, cols, rows).catch(() => {});
    });
    this.resizeObserver = new ResizeObserver(() => this.refit());
    this.resizeObserver.observe(this.el);
  }

  get title() {
    return this.profile.name || `${this.profile.username}@${this.profile.host}`;
  }

  mount() {
    this.term.open(this.el);
    this.refit();
  }

  refit() {
    if (this.el.offsetParent === null) return; // hidden tab
    try {
      this.fit.fit();
    } catch {
      /* not yet laid out */
    }
  }

  focus() {
    this.term.focus();
  }

  setFontSize(size: number) {
    this.term.options.fontSize = size;
    this.refit();
  }

  private applyModifiers(data: string) {
    const { ctrl, alt } = this.modifiers;
    if (!ctrl && !alt) return data;
    let out = data;
    if (ctrl && data.length === 1) {
      const c = data.toUpperCase().charCodeAt(0);
      // Ctrl+@..Ctrl+_ map to 0x00..0x1f; Ctrl+? is DEL.
      if (c >= 0x40 && c <= 0x5f) out = String.fromCharCode(c - 0x40);
      else if (data === "?") out = "\x7f";
      else if (data === " ") out = "\x00";
    }
    if (alt) out = "\x1b" + out;
    this.modifiers = { ctrl: false, alt: false };
    this.onModifiersUsed();
    return out;
  }

  send(data: string) {
    if (this.connId && this.state === "connected") {
      api.sshWrite(this.connId, data).catch((e) => this.term.write(`\r\n\x1b[31m${e}\x1b[0m\r\n`));
    }
  }

  /** Sends raw input that bypasses sticky modifiers (extra-keys buttons). */
  sendKey(seq: string) {
    this.send(this.modifiers.ctrl || this.modifiers.alt ? this.applyModifiers(seq) : seq);
  }

  async connect(creds: Credentials) {
    this.setState("connecting");
    const p = this.profile;
    this.term.write(`\x1b[36mMenghubungkan ke ${p.username}@${p.host}:${p.port}…\x1b[0m\r\n`);
    const channel = new Channel<TermEvent>();
    channel.onmessage = (ev) => {
      if (ev.type === "data") {
        this.term.write(b64ToBytes(ev.data));
      } else {
        this.term.write(`\r\n\x1b[33m■ ${ev.reason}. Tekan "Reconnect" untuk menyambung lagi.\x1b[0m\r\n`);
        this.setState("closed");
      }
    };
    try {
      this.refit();
      this.connId = await api.sshConnect(
        {
          requestId: this.key,
          host: p.host,
          port: p.port,
          username: p.username,
          password: creds.password,
          privateKey: creds.privateKey,
          passphrase: creds.passphrase,
          cols: this.term.cols,
          rows: this.term.rows,
        },
        channel,
      );
      if (this.state === "connecting") this.setState("connected");
      this.focus();
    } catch (e) {
      this.term.write(`\x1b[31m✖ Gagal: ${e}\x1b[0m\r\n`);
      this.setState("closed");
      throw e;
    }
  }

  private setState(s: TabState) {
    this.state = s;
    this.onStateChange();
  }

  async disconnect() {
    const id = this.connId;
    this.connId = null;
    if (id) await api.sshDisconnect(id).catch(() => {});
    this.setState("closed");
  }

  dispose() {
    this.resizeObserver.disconnect();
    this.disconnect();
    this.term.dispose();
    this.el.remove();
  }
}
