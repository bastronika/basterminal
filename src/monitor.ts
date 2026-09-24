// Remote resource monitor for SSH sessions (MobaXterm's "remote monitoring"):
// a compact status bar under the terminal plus a detailed sidebar panel.
// Samples come from `monitor_sample`; rates are derived from consecutive samples.
import { api, type MonitorSample } from "./api";
import { legend, lineChart, meter, severityTag } from "./chart";
import { errMsg, formatSize, h, setChildren } from "./ui";

const INTERVAL_MS = 3000;
const HISTORY = 60; // 3 minutes at 3 s

interface Point {
  cpu: number | null;
  rx: number | null;
  tx: number | null;
}

class HostMonitor {
  sample: MonitorSample | null = null;
  private prev: { s: MonitorSample; t: number } | null = null;
  history: Point[] = [];
  error: string | null = null;
  busy = false;

  constructor(readonly connId: string) {}

  get latest(): Point | null {
    return this.history[this.history.length - 1] ?? null;
  }

  async poll() {
    if (this.busy) return;
    this.busy = true;
    try {
      const s = await api.monitorSample(this.connId);
      const t = performance.now();
      const point: Point = { cpu: null, rx: null, tx: null };
      if (this.prev) {
        const dt = (t - this.prev.t) / 1000;
        const dTotal = s.cpuTotal - this.prev.s.cpuTotal;
        const dIdle = s.cpuIdle - this.prev.s.cpuIdle;
        if (dTotal > 0) point.cpu = Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100));
        const sum = (x: MonitorSample, k: "rxBytes" | "txBytes") => x.net.reduce((a, n) => a + n[k], 0);
        const drx = sum(s, "rxBytes") - sum(this.prev.s, "rxBytes");
        const dtx = sum(s, "txBytes") - sum(this.prev.s, "txBytes");
        // Counter resets (interface restart) would give negative rates.
        if (dt > 0 && drx >= 0) point.rx = drx / dt;
        if (dt > 0 && dtx >= 0) point.tx = dtx / dt;
        this.history.push(point);
        if (this.history.length > HISTORY) this.history.shift();
      }
      this.prev = { s, t };
      this.sample = s;
      this.error = null;
    } catch (e) {
      this.error = errMsg(e);
    } finally {
      this.busy = false;
    }
  }
}

export function formatRate(bps: number) {
  return `${formatSize(bps)}/s`;
}

export function formatUptime(secs: number) {
  const d = Math.floor(secs / 86400);
  const hr = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return d ? `${d} hari ${hr} jam` : hr ? `${hr} jam ${m} mnt` : `${m} mnt`;
}

const pct = (used: number, total: number) => (total > 0 ? (used / total) * 100 : 0);
const kb = (v: number) => formatSize(v * 1024);

export class MonitorController {
  private hosts = new Map<string, HostMonitor>();
  private activeId: string | null = null;
  private timer: number | undefined;
  /** Whether the detailed panel is visible (sidebar open on the Monitor tab). */
  panelVisible = false;
  barEnabled = localStorage.getItem("monitor") !== "off";
  readonly bar: HTMLDivElement;
  readonly panel: HTMLDivElement;

  constructor(private openPanel: () => void) {
    this.bar = h("div", { class: "monitor", role: "button", tabindex: 0, title: "Buka resource monitor", onclick: () => this.openPanel() });
    this.panel = h("div", { class: "monitor-panel" });
    this.render();
  }

  /** Active SSH connection (null when the active tab is not connected). */
  setActive(connId: string | null) {
    if (connId === this.activeId) return;
    this.activeId = connId;
    this.render();
    this.schedule(true);
  }

  forget(connId: string) {
    this.hosts.delete(connId);
  }

  setBarEnabled(on: boolean) {
    this.barEnabled = on;
    localStorage.setItem("monitor", on ? "on" : "off");
    this.render();
    this.schedule(true);
  }

  setPanelVisible(on: boolean) {
    if (on === this.panelVisible) return;
    this.panelVisible = on;
    this.render();
    this.schedule(true);
  }

  private get host() {
    if (!this.activeId) return null;
    let m = this.hosts.get(this.activeId);
    if (!m) this.hosts.set(this.activeId, (m = new HostMonitor(this.activeId)));
    return m;
  }

  private schedule(now = false) {
    clearTimeout(this.timer);
    const host = this.host;
    if (!host || !(this.barEnabled || this.panelVisible)) return;
    const tick = async () => {
      await host.poll();
      if (host === this.host) {
        this.render();
        this.timer = window.setTimeout(tick, INTERVAL_MS);
      }
    };
    this.timer = window.setTimeout(tick, now ? 0 : INTERVAL_MS);
  }

  private render() {
    this.renderBar();
    if (this.panelVisible) this.renderPanel();
  }

  private renderBar() {
    const host = this.host;
    this.bar.hidden = !host || !this.barEnabled;
    if (!host) return;
    if (host.error) {
      this.bar.replaceChildren(h("span", { class: "warn" }, `⚠ Monitor: ${host.error}`));
      return;
    }
    const s = host.sample;
    if (!s) {
      this.bar.replaceChildren(h("span", { class: "muted" }, "Monitor: memuat…"));
      return;
    }
    const p = host.latest;
    const memPct = pct(s.memTotalKb - s.memAvailableKb, s.memTotalKb);
    const root = s.disks.find((d) => d.mount === "/") ?? s.disks[0];
    const item = (k: string, v: string, m?: number) =>
      h("span", { class: "mon-item" }, h("b", {}, k), m === undefined ? null : meter(m, k), v);
    setChildren(
      this.bar,
      item("CPU", p?.cpu == null ? "…" : `${p.cpu.toFixed(0)}%`, p?.cpu ?? 0),
      item("RAM", `${memPct.toFixed(0)}%`, memPct),
      item("↓", p?.rx == null ? "…" : formatRate(p.rx)),
      item("↑", p?.tx == null ? "…" : formatRate(p.tx)),
      root ? item("Disk", `${pct(root.usedKb, root.totalKb).toFixed(0)}%`) : null,
      item("⏱", formatUptime(s.uptimeSecs)),
      h("span", { class: "mon-more" }, "Detail ›"),
    );
  }

  private renderPanel() {
    const host = this.host;
    if (!host) {
      this.panel.replaceChildren(h("p", { class: "muted pad" }, "Buka sesi SSH untuk melihat resource server."));
      return;
    }
    const s = host.sample;
    if (!s) {
      this.panel.replaceChildren(
        h("p", { class: host.error ? "error pad" : "muted pad" }, host.error ?? "Mengambil data dari server…"),
      );
      return;
    }
    // Panel padding (2×14) + card padding and border (2×13).
    const width = Math.max(180, (this.panel.clientWidth || 280) - 54);
    const cpuVals = host.history.map((p) => p.cpu);
    const latest = host.latest;
    const memUsed = s.memTotalKb - s.memAvailableKb;
    const memPct = pct(memUsed, s.memTotalKb);
    const swapUsed = s.swapTotalKb - s.swapFreeKb;
    const xLabel = (i: number) => {
      const secsAgo = ((host.history.length - 1 - i) * INTERVAL_MS) / 1000;
      return secsAgo === 0 ? "sekarang" : `${secsAgo} dtk lalu`;
    };
    const net = [
      { label: "Download", color: "var(--series-1)", values: host.history.map((p) => p.rx) },
      { label: "Upload", color: "var(--series-2)", values: host.history.map((p) => p.tx) },
    ];

    const tile = (label: string, value: string, extra?: Node | null, sub?: string) =>
      h("div", { class: "stat" }, h("div", { class: "stat-label" }, label, " ", extra ?? null), h("div", { class: "stat-value" }, value), sub ? h("div", { class: "stat-sub" }, sub) : null);

    this.panel.replaceChildren(
      h(
        "div",
        { class: "mon-head" },
        h("strong", {}, s.hostname || "server"),
        h("div", { class: "muted" }, [s.os, s.kernel].filter(Boolean).join(" · ")),
        h("div", { class: "muted" }, `Uptime ${formatUptime(s.uptimeSecs)} · ${s.users} user login · ${s.cpuCount} core`),
        host.error ? h("div", { class: "warn" }, `⚠ ${host.error}`) : null,
      ),
      h(
        "section",
        { class: "mon-section" },
        tile("CPU", latest?.cpu == null ? "…" : `${latest.cpu.toFixed(1)}%`, latest?.cpu == null ? null : severityTag(latest.cpu),
          `Load ${s.load.map((l) => l.toFixed(2)).join(" / ")} · ${s.tasksRunning}/${s.tasksTotal} task`),
        cpuVals.length > 1
          ? lineChart([{ label: "CPU", color: "var(--series-1)", values: cpuVals }], { width, height: 64, max: 100, format: (v) => `${v.toFixed(1)}%`, xLabel })
          : h("p", { class: "muted small" }, "Grafik muncul setelah beberapa detik…"),
      ),
      h(
        "section",
        { class: "mon-section" },
        tile("Memori", `${kb(memUsed)} / ${kb(s.memTotalKb)}`, severityTag(memPct), `${memPct.toFixed(0)}% terpakai · ${kb(s.memAvailableKb)} tersedia`),
        meter(memPct, "Memori"),
        s.swapTotalKb > 0
          ? h("div", { class: "mon-sub" }, h("div", { class: "row-between" }, h("span", {}, "Swap"), h("span", {}, `${kb(swapUsed)} / ${kb(s.swapTotalKb)}`)), meter(pct(swapUsed, s.swapTotalKb), "Swap"))
          : null,
      ),
      h(
        "section",
        { class: "mon-section" },
        h("div", { class: "stat-label" }, "Jaringan"),
        legend(net, [latest?.rx == null ? "…" : formatRate(latest.rx), latest?.tx == null ? "…" : formatRate(latest.tx)]),
        host.history.length > 1
          ? lineChart(net, { width, height: 72, format: formatRate, xLabel })
          : null,
        h("div", { class: "muted small" }, s.net.map((n) => `${n.name}: ↓${formatSize(n.rxBytes)} ↑${formatSize(n.txBytes)}`).join(" · ")),
      ),
      h(
        "section",
        { class: "mon-section" },
        h("div", { class: "stat-label" }, "Disk"),
        ...s.disks.map((d) => {
          const p = pct(d.usedKb, d.totalKb);
          return h(
            "div",
            { class: "mon-sub" },
            h("div", { class: "row-between" }, h("code", {}, d.mount), h("span", {}, `${kb(d.usedKb)} / ${kb(d.totalKb)} (${p.toFixed(0)}%) `, severityTag(p))),
            meter(p, `Disk ${d.mount}`),
          );
        }),
      ),
      h(
        "section",
        { class: "mon-section" },
        h("div", { class: "stat-label" }, "Proses teratas", s.processesLive ? null : h("span", { class: "muted small" }, " (CPU% rata-rata sejak start)")),
        s.processes.length
          ? h(
              "table",
              { class: "proc-table" },
              h("thead", {}, h("tr", {}, h("th", {}, "PID"), h("th", {}, "User"), h("th", { class: "num" }, "CPU%"), h("th", { class: "num" }, "MEM%"), h("th", {}, "Perintah"))),
              h(
                "tbody",
                {},
                ...s.processes.map((p) =>
                  h("tr", {}, h("td", { class: "num" }, String(p.pid)), h("td", {}, p.user), h("td", { class: "num" }, p.cpu.toFixed(1)), h("td", { class: "num" }, p.mem == null ? "–" : p.mem.toFixed(1)), h("td", { class: "cmd" }, p.command)),
                ),
              ),
            )
          : h("p", { class: "muted small" }, "Daftar proses tidak tersedia."),
      ),
    );
  }
}
