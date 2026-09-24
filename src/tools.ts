// "Tools" menu: network utilities and SSH tunnels, plus the known-hosts manager.
import { api } from "./api";
import { errMsg, field, h, modal, toast } from "./ui";

const COMMON_PORTS = [
  21, 22, 23, 25, 53, 80, 110, 111, 135, 139, 143, 443, 445, 465, 587, 993, 995, 1433, 1521, 1723, 1883, 2049,
  2375, 3000, 3306, 3389, 5000, 5432, 5672, 5900, 6379, 6443, 8000, 8006, 8080, 8081, 8443, 8888, 9000, 9090,
  9200, 10000, 11211, 27017,
];

function parsePorts(spec: string): number[] {
  const out = new Set<number>();
  for (const part of spec.split(/[\s,]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) continue;
    const a = Number(m[1]);
    const b = Number(m[2] ?? m[1]);
    for (let p = Math.max(1, a); p <= Math.min(65535, b); p++) out.add(p);
  }
  return [...out];
}

const input = (value: string, attrs: Record<string, string> = {}) =>
  h("input", { value, autocapitalize: "off", autocomplete: "off", spellcheck: "false", ...attrs });

export async function netToolsDialog() {
  const host = input(localStorage.getItem("tools.host") ?? "", { placeholder: "host / IP" });
  const port = input("80", { type: "number" });
  const ports = input(COMMON_PORTS.join(","), {});
  const out = h("pre", { class: "tool-output" }, "Pilih alat di bawah.");
  const log = (s: string) => (out.textContent = s);
  const append = (s: string) => (out.textContent += s);

  const run = async (fn: () => Promise<void>) => {
    if (!host.value.trim()) return toast("Isi host dulu", "error");
    localStorage.setItem("tools.host", host.value.trim());
    try {
      await fn();
    } catch (e) {
      append(`\nError: ${errMsg(e)}`);
    }
  };

  const ping = () =>
    run(async () => {
      log(`TCP ping ${host.value}:${port.value}\n`);
      const res = await api.tcpPing(host.value.trim(), Number(port.value), 5, 3000);
      for (const r of res) append(r.ok ? `seq=${r.seq} ${r.ms.toFixed(1)} ms\n` : `seq=${r.seq} gagal: ${r.error}\n`);
      const ok = res.filter((r) => r.ok);
      if (ok.length) {
        const avg = ok.reduce((s, r) => s + r.ms, 0) / ok.length;
        append(`\n${ok.length}/${res.length} sukses, rata-rata ${avg.toFixed(1)} ms`);
      }
    });
  const scan = () =>
    run(async () => {
      const list = parsePorts(ports.value);
      log(`Scan ${list.length} port di ${host.value}…\n`);
      const res = await api.portScan(host.value.trim(), list, 1500);
      append(res.length ? res.map((r) => `  ${r.port}/tcp  open`).join("\n") : "Tidak ada port terbuka.");
    });
  const dns = () =>
    run(async () => {
      log(`DNS ${host.value}\n`);
      const ips = await api.dnsLookup(host.value.trim());
      append(ips.join("\n") || "(tidak ada hasil)");
    });

  const body = h(
    "div",
    { class: "form" },
    field("Host", host),
    h(
      "div",
      { class: "row" },
      field("Port (ping)", port),
      h("div", { class: "tool-btns" }, h("button", { class: "btn", type: "button", onclick: ping }, "TCP Ping")),
    ),
    field("Port scan (mis. 22,80,8000-8100)", ports),
    h(
      "div",
      { class: "tool-btns" },
      h("button", { class: "btn", type: "button", onclick: scan }, "Scan port"),
      h("button", { class: "btn", type: "button", onclick: dns }, "DNS lookup"),
    ),
    out,
  );
  await modal("Network tools", body, [{ label: "Tutup", value: "close" }]);
}

export async function tunnelsDialog(connId: string | null, label: string) {
  if (!connId) return toast("Buka/aktifkan sesi SSH dulu", "error");
  const list = h("div", { class: "tunnel-list" });
  const refresh = async () => {
    const tunnels = await api.tunnelList(connId);
    list.replaceChildren(
      ...(tunnels.length
        ? tunnels.map((t) =>
            h(
              "div",
              { class: "tunnel-row" },
              h("code", {}, `127.0.0.1:${t.localPort} → ${t.remoteHost}:${t.remotePort}`),
              h("span", { class: "muted" }, ` ${t.connections} koneksi `),
              h(
                "button",
                {
                  class: "btn danger small",
                  type: "button",
                  onclick: async () => {
                    await api.tunnelStop(connId, t.id);
                    refresh();
                  },
                },
                "Stop",
              ),
            ),
          )
        : [h("p", { class: "muted" }, "Belum ada tunnel.")]),
    );
  };
  const local = input("8080", { type: "number" });
  const rhost = input("127.0.0.1");
  const rport = input("80", { type: "number" });
  const add = async () => {
    try {
      const t = await api.tunnelStart(connId, Number(local.value), rhost.value.trim(), Number(rport.value));
      toast(`Tunnel aktif di 127.0.0.1:${t.localPort}`, "ok");
      refresh();
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  const body = h(
    "div",
    { class: "form" },
    h("p", { class: "muted" }, `Local port forwarding (ssh -L) lewat ${label}. Buka http://127.0.0.1:<port> di browser HP.`),
    h(
      "div",
      { class: "row" },
      field("Port lokal", local),
      field("Host tujuan", rhost),
      field("Port tujuan", rport),
    ),
    h("button", { class: "btn primary", type: "button", onclick: add }, "Mulai tunnel"),
    list,
  );
  refresh().catch((e) => toast(errMsg(e), "error"));
  await modal("SSH Tunnel", body, [{ label: "Tutup", value: "close" }]);
}

export async function knownHostsDialog() {
  const list = h("div", { class: "tunnel-list" });
  const refresh = async () => {
    const hosts = await api.knownHostsList();
    const keys = Object.keys(hosts).sort();
    list.replaceChildren(
      ...(keys.length
        ? keys.map((host) =>
            h(
              "div",
              { class: "tunnel-row column" },
              h("strong", {}, host),
              h("code", { class: "fp" }, `${hosts[host].algorithm} ${hosts[host].fingerprint}`),
              h(
                "button",
                {
                  class: "btn danger small",
                  type: "button",
                  onclick: async () => {
                    await api.knownHostsRemove(host);
                    refresh();
                  },
                },
                "Lupakan",
              ),
            ),
          )
        : [h("p", { class: "muted" }, "Belum ada host tepercaya.")]),
    );
  };
  await refresh();
  await modal("Known hosts", list, [{ label: "Tutup", value: "close" }]);
}
