// Network tools page (MobaXterm "Tools → Network"): ping, traceroute, port
// scanner, LAN scanner, DNS, whois, Wake-on-LAN, subnet calculator and the
// device's interfaces. Long-running tools stream results and can be stopped.
import { Channel } from "@tauri-apps/api/core";
import { api, type IfaceInfo, type LanEvent, type PingEvent, type ScanEvent, type TraceEvent } from "./api";
import { lineChart } from "./chart";
import { errMsg, field, h, setChildren, toast } from "./ui";

// ------------------------------------------------------------------ shared bits

export const SERVICES: Record<number, string> = {
  20: "ftp-data", 21: "ftp", 22: "ssh", 23: "telnet", 25: "smtp", 43: "whois", 53: "dns", 67: "dhcp", 69: "tftp", 80: "http",
  81: "http-alt", 88: "kerberos", 110: "pop3", 111: "rpcbind", 119: "nntp", 123: "ntp", 135: "msrpc", 137: "netbios-ns",
  139: "netbios-ssn", 143: "imap", 161: "snmp", 179: "bgp", 389: "ldap", 443: "https", 445: "smb", 465: "smtps",
  500: "isakmp", 514: "syslog", 515: "printer", 548: "afp", 554: "rtsp", 587: "submission", 631: "ipp", 636: "ldaps",
  853: "dns-tls", 873: "rsync", 902: "vmware", 990: "ftps", 993: "imaps", 995: "pop3s", 1080: "socks", 1194: "openvpn",
  1433: "mssql", 1521: "oracle", 1701: "l2tp", 1723: "pptp", 1883: "mqtt", 1900: "upnp", 2049: "nfs", 2082: "cpanel",
  2083: "cpanel-ssl", 2181: "zookeeper", 2375: "docker", 2376: "docker-tls", 3000: "http-dev", 3128: "squid",
  3306: "mysql", 3389: "rdp", 3478: "stun", 4369: "epmd", 5000: "upnp/http", 5060: "sip", 5222: "xmpp", 5353: "mdns",
  5432: "postgres", 5601: "kibana", 5672: "amqp", 5900: "vnc", 5901: "vnc-1", 5985: "winrm", 6379: "redis",
  6443: "kubernetes", 6667: "irc", 7000: "airplay", 8000: "http-alt", 8006: "proxmox", 8008: "http-alt",
  8080: "http-proxy", 8081: "http-alt", 8123: "home-assistant", 8291: "winbox", 8443: "https-alt", 8728: "mikrotik-api",
  8888: "http-alt", 9000: "http-alt", 9090: "prometheus", 9100: "jetdirect", 9200: "elasticsearch", 9418: "git",
  10000: "webmin", 11211: "memcached", 27017: "mongodb", 32400: "plex", 51820: "wireguard", 62078: "iphone-sync",
};

const COMMON_PORTS = Object.keys(SERVICES).map(Number).sort((a, b) => a - b);

export function parsePorts(spec: string): number[] {
  const out = new Set<number>();
  for (const part of spec.split(/[\s,]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) continue;
    const a = Number(m[1]);
    const b = Number(m[2] ?? m[1]);
    for (let p = Math.max(1, Math.min(a, b)); p <= Math.min(65535, Math.max(a, b)); p++) out.add(p);
  }
  return [...out].sort((a, b) => a - b);
}

const inp = (value: string, attrs: Record<string, string> = {}) =>
  h("input", { value, autocapitalize: "off", autocomplete: "off", spellcheck: "false", ...attrs });

const remembered = (key: string, fallback: string) => {
  try {
    return localStorage.getItem(`nt.${key}`) ?? fallback;
  } catch {
    return fallback;
  }
};
const remember = (key: string, value: string) => {
  try {
    localStorage.setItem(`nt.${key}`, value);
  } catch {
    /* storage unavailable */
  }
};

/** Start/stop button pair driving one cancellable streamed job. */
class Job {
  id: string | null = null;
  readonly start: HTMLButtonElement;
  readonly stop: HTMLButtonElement;

  constructor(label: string, run: (jobId: string) => Promise<void>) {
    this.start = h("button", { class: "btn primary", type: "button" }, label);
    this.stop = h("button", { class: "btn danger", type: "button", hidden: true }, "Stop");
    this.start.addEventListener("click", async () => {
      if (this.id) return;
      const id = crypto.randomUUID();
      this.id = id;
      this.start.hidden = true;
      this.stop.hidden = false;
      try {
        await run(id);
      } catch (e) {
        toast(errMsg(e), "error");
      } finally {
        this.id = null;
        this.start.hidden = false;
        this.stop.hidden = true;
      }
    });
    this.stop.addEventListener("click", () => this.id && api.netCancel(this.id));
  }

  get buttons() {
    return h("div", { class: "tool-btns" }, this.start, this.stop);
  }
}

const progressBar = () => {
  const fill = h("div", { class: "meter-fill" });
  const text = h("span", { class: "muted small" });
  const el = h("div", { class: "progress" }, h("div", { class: "meter" }, fill), text);
  return {
    el,
    set(done: number, total: number, extra = "") {
      fill.style.width = `${total ? (done / total) * 100 : 0}%`;
      text.textContent = `${done}/${total}${extra}`;
    },
  };
};

const table = (headers: string[], numeric: number[] = []) => {
  const body = h("tbody");
  const el = h(
    "table",
    { class: "result-table" },
    h("thead", {}, h("tr", {}, ...headers.map((t, i) => h("th", { class: numeric.includes(i) ? "num" : "" }, t)))),
    body,
  );
  return { el, body };
};

const cell = (text: string, cls = "") => h("td", { class: cls }, text);

/** Milliseconds with more precision for sub-millisecond LAN latencies. */
const fmtMs = (v: number) => `${v < 1 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : v.toFixed(0)} ms`;

// ------------------------------------------------------------------ tools

function pingTool() {
  const host = inp(remembered("host", ""), { placeholder: "host / IP" });
  const count = inp("10", { type: "number", min: "1", max: "1000" });
  const port = inp("443", { type: "number", min: "1", max: "65535" });
  const info = h("div", { class: "muted small" });
  const summary = h("div", { class: "tool-summary" });
  const chartBox = h("div", {});
  const log = h("pre", { class: "tool-output" });
  let rtts: (number | null)[] = [];

  const render = () => {
    const ok = rtts.filter((v): v is number => v !== null);
    const loss = rtts.length ? ((rtts.length - ok.length) / rtts.length) * 100 : 0;
    setChildren(
      summary,
      h("span", {}, h("b", {}, "Terkirim "), String(rtts.length)),
      h("span", {}, h("b", {}, "Diterima "), String(ok.length)),
      h("span", {}, h("b", {}, "Loss "), `${loss.toFixed(0)}%`),
      ok.length ? h("span", {}, h("b", {}, "min/avg/max "), [Math.min(...ok), ok.reduce((a, b) => a + b, 0) / ok.length, Math.max(...ok)].map(fmtMs).join(" / ")) : null,
    );
    chartBox.replaceChildren(
      rtts.length > 1
        ? lineChart([{ label: "RTT", color: "var(--series-1)", values: rtts }], {
            width: Math.max(200, chartBox.clientWidth || 300),
            height: 90,
            format: fmtMs,
            xLabel: (i) => `seq ${i + 1}`,
          })
        : "",
    );
  };

  const job = new Job("Ping", async (jobId) => {
    remember("host", host.value.trim());
    rtts = [];
    log.textContent = "";
    info.textContent = "";
    render();
    const ch = new Channel<PingEvent>();
    ch.onmessage = (e) => {
      if (e.type === "start") {
        info.textContent = `${host.value.trim()} (${e.ip}) · mode ${e.mode}${e.note ? ` · ${e.note}` : ""}`;
        return;
      }
      if (e.type === "reply") {
        rtts.push(e.ms);
        log.textContent += `seq=${e.seq} waktu=${fmtMs(e.ms)}\n`;
      } else if (e.type === "timeout") {
        rtts.push(null);
        log.textContent += `seq=${e.seq} timeout\n`;
      } else {
        rtts.push(null);
        log.textContent += `seq=${e.seq} error: ${e.message}\n`;
      }
      log.scrollTop = log.scrollHeight;
      render();
    };
    await api.netPing(jobId, host.value.trim(), Number(count.value) || 10, 1000, 2000, Number(port.value) || 443, ch);
  });

  return h(
    "div",
    { class: "form" },
    field("Host", host),
    h("div", { class: "row" }, field("Jumlah", count), field("Port TCP cadangan", port, "dipakai jika ICMP tidak diizinkan")),
    job.buttons,
    info,
    summary,
    chartBox,
    log,
  );
}

function traceTool() {
  const host = inp(remembered("host", ""), { placeholder: "host / IP" });
  const hops = inp("30", { type: "number", min: "1", max: "64" });
  const info = h("div", { class: "muted small" });
  const t = table(["#", "Host", "RTT 1", "RTT 2", "RTT 3"], [0, 2, 3, 4]);
  const rows = new Map<number, HTMLTableRowElement>();
  const names = new Map<number, string>();

  const job = new Job("Traceroute", async (jobId) => {
    remember("host", host.value.trim());
    t.body.replaceChildren();
    rows.clear();
    names.clear();
    info.textContent = "";
    const ch = new Channel<TraceEvent>();
    ch.onmessage = (e) => {
      if (e.type === "start") {
        info.textContent = `Rute ke ${e.ip}, maks. ${e.maxHops} hop (ICMP, IPv4)`;
      } else if (e.type === "hop") {
        const hostCell = h("td", { class: "host-cell" }, e.ip ?? "*", names.get(e.ttl) ? h("div", { class: "muted small" }, names.get(e.ttl)!) : null, e.note ? h("div", { class: "warn small" }, e.note) : null);
        const row = h("tr", { class: e.reached ? "reached" : "" }, cell(String(e.ttl), "num"), hostCell, ...[0, 1, 2].map((i) => cell(e.rtts[i] == null ? "*" : fmtMs(e.rtts[i]!), "num")));
        rows.set(e.ttl, row);
        t.body.append(row);
      } else {
        names.set(e.ttl, e.name);
        const hostCell = rows.get(e.ttl)?.children[1];
        if (hostCell && !hostCell.querySelector(".muted")) hostCell.append(h("div", { class: "muted small" }, e.name));
      }
    };
    await api.netTraceroute(jobId, host.value.trim(), Number(hops.value) || 30, 1500, ch);
    info.textContent += " · selesai";
  });

  return h("div", { class: "form" }, field("Host", host), field("Maks. hop", hops), job.buttons, info, h("div", { class: "table-scroll" }, t.el));
}

function portScanTool() {
  const host = inp(remembered("host", ""), { placeholder: "host / IP" });
  const preset = h(
    "select",
    {},
    h("option", { value: "common" }, `Port umum (${COMMON_PORTS.length})`),
    h("option", { value: "1-1024" }, "Well-known 1–1024"),
    h("option", { value: "1-65535" }, "Semua 1–65535"),
    h("option", { value: "custom" }, "Kustom…"),
  );
  const custom = inp("22,80,443,8000-8100", { placeholder: "mis. 22,80,8000-8100" });
  const customField = field("Daftar port", custom);
  customField.hidden = true;
  preset.addEventListener("change", () => (customField.hidden = preset.value !== "custom"));
  const timeout = inp("800", { type: "number", min: "100", max: "10000" });
  const banners = h("input", { type: "checkbox", checked: true });
  const progress = progressBar();
  const info = h("div", { class: "muted small" });
  const t = table(["Port", "Layanan", "RTT", "Banner"], [0, 2]);
  const found: { port: number; row: HTMLTableRowElement }[] = [];

  const job = new Job("Scan", async (jobId) => {
    remember("host", host.value.trim());
    const ports = preset.value === "common" ? COMMON_PORTS : parsePorts(preset.value === "custom" ? custom.value : preset.value);
    if (!ports.length) throw new Error("Daftar port kosong");
    t.body.replaceChildren();
    found.length = 0;
    progress.set(0, ports.length);
    const started = performance.now();
    const ch = new Channel<ScanEvent>();
    ch.onmessage = (e) => {
      if (e.type === "start") info.textContent = `Memindai ${e.total} port di ${e.ip}`;
      else if (e.type === "progress") progress.set(e.done, e.total, ` · ${found.length} terbuka`);
      else {
        const row = h("tr", {}, cell(String(e.port), "num"), cell(SERVICES[e.port] ?? "?"), cell(fmtMs(e.ms), "num"), cell(e.banner ?? "", "cmd"));
        found.push({ port: e.port, row });
        found.sort((a, b) => a.port - b.port);
        t.body.replaceChildren(...found.map((f) => f.row));
      }
    };
    await api.netPortScan(jobId, host.value.trim(), ports, Number(timeout.value) || 800, 200, banners.checked, ch);
    info.textContent += ` · selesai dalam ${((performance.now() - started) / 1000).toFixed(1)} dtk, ${found.length} port terbuka`;
  });

  return h(
    "div",
    { class: "form" },
    field("Host", host),
    h("div", { class: "row" }, field("Port", preset), field("Timeout (ms)", timeout)),
    customField,
    h("label", { class: "check" }, banners, "Ambil banner layanan (SSH/FTP/SMTP…)"),
    job.buttons,
    info,
    progress.el,
    h("div", { class: "table-scroll" }, t.el),
  );
}

function lanScanTool(ifaces: Promise<IfaceInfo[]>) {
  const cidr = inp(remembered("cidr", ""), { placeholder: "192.168.1.0/24" });
  ifaces.then((list) => {
    const lan = list.find((i) => !i.loopback && !i.ipv6 && i.network);
    if (!cidr.value && lan) cidr.value = `${lan.ip}/${Math.max(lan.prefix, 22)}`;
  });
  const progress = progressBar();
  const info = h("div", { class: "muted small" });
  const t = table(["IP", "Nama", "RTT", "Port terbuka"], [2]);
  const hosts = new Map<string, { ms: number | null; ports: number[]; name?: string; via: string }>();
  const ipKey = (ip: string) => ip.split(".").reduce((a, o) => a * 256 + Number(o), 0);
  const render = () =>
    t.body.replaceChildren(
      ...[...hosts]
        .sort((a, b) => ipKey(a[0]) - ipKey(b[0]))
        .map(([ip, x]) =>
          h(
            "tr",
            {},
            cell(ip),
            cell(x.name ?? ""),
            cell(x.ms == null ? "" : fmtMs(x.ms), "num"),
            cell(x.ports.map((p) => (SERVICES[p] ? `${p} ${SERVICES[p]}` : String(p))).join(", ")),
          ),
        ),
    );

  const job = new Job("Scan jaringan", async (jobId) => {
    remember("cidr", cidr.value.trim());
    hosts.clear();
    render();
    const ch = new Channel<LanEvent>();
    ch.onmessage = (e) => {
      if (e.type === "start") {
        info.textContent = `Memindai ${e.total} alamat${e.icmp ? " (ICMP + TCP)" : ""}${e.note ? ` · ${e.note}` : ""}`;
        progress.set(0, e.total);
        return;
      }
      if (e.type === "progress") {
        progress.set(e.done, e.total, ` · ${hosts.size} host aktif`);
        return;
      }
      if (e.type === "host") {
        const cur = hosts.get(e.ip);
        hosts.set(e.ip, {
          ms: cur?.ms ?? e.ms,
          ports: [...new Set([...(cur?.ports ?? []), ...e.ports])].sort((a, b) => a - b),
          name: cur?.name,
          via: cur?.via ?? e.via,
        });
      } else {
        const cur = hosts.get(e.ip);
        if (cur) cur.name = e.name;
      }
      render();
    };
    await api.netLanScan(jobId, cidr.value.trim(), 600, ch);
    info.textContent += ` · selesai: ${hosts.size} host aktif`;
  });

  return h(
    "div",
    { class: "form" },
    field("Jaringan (CIDR)", cidr, "maks. /20 · diisi otomatis dari Wi-Fi/LAN perangkat"),
    job.buttons,
    info,
    progress.el,
    h("div", { class: "table-scroll" }, t.el),
  );
}

function dnsTool() {
  const name = inp(remembered("dns", ""), { placeholder: "domain.com atau IP (PTR)" });
  const rtype = h("select", {}, ...["A", "AAAA", "CNAME", "MX", "NS", "TXT", "SOA", "SRV", "CAA", "PTR"].map((t) => h("option", { value: t }, t)));
  const server = h(
    "select",
    {},
    h("option", { value: "1.1.1.1" }, "Cloudflare 1.1.1.1"),
    h("option", { value: "8.8.8.8" }, "Google 8.8.8.8"),
    h("option", { value: "9.9.9.9" }, "Quad9 9.9.9.9"),
    h("option", { value: "system" }, "Resolver sistem (A/AAAA/PTR)"),
    h("option", { value: "custom" }, "Server lain…"),
  );
  server.value = remembered("dnsServer", "1.1.1.1");
  const custom = inp(remembered("dnsCustom", ""), { placeholder: "IP server DNS" });
  const customField = field("IP server DNS", custom);
  const sync = () => (customField.hidden = server.value !== "custom");
  server.addEventListener("change", sync);
  sync();
  const info = h("div", { class: "muted small" });
  const t = table(["Nama", "Tipe", "TTL", "Data"], [2]);
  const go = h("button", { class: "btn primary", type: "button" }, "Query");
  go.addEventListener("click", async () => {
    const srv = server.value === "custom" ? custom.value.trim() : server.value;
    remember("dns", name.value.trim());
    remember("dnsServer", server.value);
    remember("dnsCustom", custom.value.trim());
    go.disabled = true;
    info.textContent = "Mencari…";
    try {
      const res = await api.netDnsQuery(name.value, rtype.value, srv);
      info.textContent = `${res.records.length} record dari ${res.server} dalam ${res.ms.toFixed(0)} ms`;
      t.body.replaceChildren(...res.records.map((r) => h("tr", {}, cell(r.name), cell(r.rtype), cell(String(r.ttl), "num"), cell(r.data, "cmd"))));
    } catch (e) {
      info.textContent = "";
      t.body.replaceChildren();
      toast(errMsg(e), "error");
    } finally {
      go.disabled = false;
    }
  });
  return h(
    "div",
    { class: "form" },
    field("Nama / IP", name),
    h("div", { class: "row" }, field("Tipe", rtype), field("Server", server)),
    customField,
    h("div", { class: "tool-btns" }, go),
    info,
    h("div", { class: "table-scroll" }, t.el),
  );
}

function whoisTool() {
  const q = inp(remembered("whois", ""), { placeholder: "domain.com atau IP" });
  const out = h("pre", { class: "tool-output tall" });
  const go = h("button", { class: "btn primary", type: "button" }, "Whois");
  go.addEventListener("click", async () => {
    remember("whois", q.value.trim());
    go.disabled = true;
    out.textContent = "Menghubungi whois.iana.org…";
    try {
      out.textContent = await api.netWhois(q.value);
    } catch (e) {
      out.textContent = `Error: ${errMsg(e)}`;
    } finally {
      go.disabled = false;
    }
  });
  return h("div", { class: "form" }, field("Domain / IP", q), h("div", { class: "tool-btns" }, go), out);
}

interface WolDevice {
  name: string;
  mac: string;
  broadcast: string;
  port: number;
}

function wolTool(ifaces: Promise<IfaceInfo[]>) {
  const load = (): WolDevice[] => {
    try {
      return JSON.parse(remembered("wol", "[]"));
    } catch {
      return [];
    }
  };
  const name = inp("", { placeholder: "mis. PC Kantor" });
  const mac = inp("", { placeholder: "AA:BB:CC:DD:EE:FF" });
  const bcast = inp("255.255.255.255");
  const port = inp("9", { type: "number" });
  ifaces.then((list) => {
    const lan = list.find((i) => !i.loopback && !i.ipv6 && i.network);
    if (lan?.network) bcast.value = subnetInfo(lan.network)?.broadcast ?? bcast.value;
  });
  const list = h("div", { class: "tunnel-list" });
  const send = async (d: WolDevice) => {
    try {
      await api.netWol(d.mac, d.broadcast, d.port);
      toast(`Magic packet dikirim ke ${d.mac}`, "ok");
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  const render = () => {
    const devs = load();
    list.replaceChildren(
      ...devs.map((d, i) =>
        h(
          "div",
          { class: "tunnel-row" },
          h("div", { class: "grow" }, h("strong", {}, d.name || d.mac), h("div", { class: "muted small" }, `${d.mac} → ${d.broadcast}:${d.port}`)),
          h("button", { class: "btn primary small", type: "button", onclick: () => send(d) }, "Bangunkan"),
          h("button", { class: "btn small", type: "button", onclick: () => (remember("wol", JSON.stringify(devs.filter((_, j) => j !== i))), render()) }, "Hapus"),
        ),
      ),
    );
  };
  render();
  const current = (): WolDevice => ({ name: name.value.trim(), mac: mac.value.trim(), broadcast: bcast.value.trim(), port: Number(port.value) || 9 });
  return h(
    "div",
    { class: "form" },
    h("div", { class: "row" }, field("Nama", name), field("MAC", mac)),
    h("div", { class: "row" }, field("Broadcast", bcast), h("div", { class: "narrow" }, field("Port", port))),
    h(
      "div",
      { class: "tool-btns" },
      h("button", { class: "btn primary", type: "button", onclick: () => send(current()) }, "Kirim magic packet"),
      h("button", { class: "btn", type: "button", onclick: () => (remember("wol", JSON.stringify([...load(), current()])), render()) }, "Simpan perangkat"),
    ),
    list,
  );
}

// ------------------------------------------------------------------ subnet calculator

const ipToInt = (ip: string) => {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
};
const intToIp = (n: number) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join(".");

export function subnetInfo(input: string) {
  const m = input.trim().match(/^(\d+\.\d+\.\d+\.\d+)\s*(?:\/\s*(\d+)|\s+(\d+\.\d+\.\d+\.\d+))?$/);
  if (!m) return null;
  const ip = ipToInt(m[1]);
  if (ip === null) return null;
  let prefix = m[2] !== undefined ? Number(m[2]) : 24;
  if (m[3]) {
    const mask = ipToInt(m[3]);
    if (mask === null) return null;
    prefix = mask.toString(2).padStart(32, "0").indexOf("0");
    if (prefix < 0) prefix = 32;
    if (((0xffffffff << (32 - prefix)) >>> 0) !== mask && prefix !== 0) return null;
  }
  if (prefix < 0 || prefix > 32) return null;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const net = (ip & mask) >>> 0;
  const bcast = (net | (~mask >>> 0)) >>> 0;
  const hosts = prefix >= 31 ? 2 ** (32 - prefix) : 2 ** (32 - prefix) - 2;
  const first = prefix >= 31 ? net : net + 1;
  const last = prefix >= 31 ? bcast : bcast - 1;
  const o1 = ip >>> 24;
  const cls = o1 < 128 ? "A" : o1 < 192 ? "B" : o1 < 224 ? "C" : o1 < 240 ? "D (multicast)" : "E";
  const priv = (ip & 0xff000000) >>> 0 === 0x0a000000 || (ip & 0xfff00000) >>> 0 === 0xac100000 || (ip & 0xffff0000) >>> 0 === 0xc0a80000;
  const cgnat = (ip & 0xffc00000) >>> 0 === 0x64400000;
  return {
    address: intToIp(ip),
    prefix,
    netmask: intToIp(mask),
    wildcard: intToIp(~mask >>> 0),
    network: `${intToIp(net)}/${prefix}`,
    broadcast: intToIp(bcast),
    first: intToIp(first),
    last: intToIp(last),
    hosts,
    cls,
    scope: priv ? "Privat (RFC 1918)" : cgnat ? "CGNAT (RFC 6598)" : o1 === 127 ? "Loopback" : "Publik",
    binary: intToIp(ip).split(".").map((o) => Number(o).toString(2).padStart(8, "0")).join("."),
  };
}

function subnetTool() {
  const q = inp(remembered("subnet", "192.168.1.10/24"), { placeholder: "IP/prefix atau IP netmask" });
  const out = h("div", {});
  const calc = () => {
    remember("subnet", q.value);
    const r = subnetInfo(q.value);
    if (!r) {
      out.replaceChildren(h("p", { class: "error" }, "Format: 192.168.1.10/24 atau 192.168.1.10 255.255.255.0"));
      return;
    }
    const rows: [string, string][] = [
      ["Alamat", r.address],
      ["Network", r.network],
      ["Netmask", `${r.netmask} (/${r.prefix})`],
      ["Wildcard", r.wildcard],
      ["Broadcast", r.broadcast],
      ["Host pertama", r.first],
      ["Host terakhir", r.last],
      ["Jumlah host", r.hosts.toLocaleString("id-ID")],
      ["Kelas", r.cls],
      ["Jenis", r.scope],
      ["Biner", r.binary],
    ];
    out.replaceChildren(h("table", { class: "result-table kv" }, h("tbody", {}, ...rows.map(([k, v]) => h("tr", {}, h("th", {}, k), cell(v, "cmd"))))));
  };
  q.addEventListener("input", calc);
  calc();
  return h("div", { class: "form" }, field("IP / subnet", q), out);
}

function infoTool(ifaces: Promise<IfaceInfo[]>) {
  const t = table(["Interface", "Alamat", "Network"]);
  ifaces
    .then((list) => t.body.replaceChildren(...list.map((i) => h("tr", {}, cell(i.name), cell(`${i.ip}/${i.prefix}`, "cmd"), cell(i.network ?? (i.ipv6 ? "IPv6" : ""))))))
    .catch((e) => t.body.replaceChildren(h("tr", {}, cell(errMsg(e), "error"))));
  return h("div", { class: "form" }, h("p", { class: "muted small" }, "Alamat jaringan perangkat ini."), h("div", { class: "table-scroll" }, t.el));
}

// ------------------------------------------------------------------ page

const TOOLS = [
  ["ping", "Ping"],
  ["trace", "Traceroute"],
  ["ports", "Port scan"],
  ["lan", "Scan LAN"],
  ["dns", "DNS"],
  ["whois", "Whois"],
  ["wol", "Wake-on-LAN"],
  ["subnet", "Subnet"],
  ["info", "Info"],
] as const;
type ToolId = (typeof TOOLS)[number][0];

export function createNetToolsPage() {
  const ifaces = api.netInterfaces();
  ifaces.catch(() => {});
  const builders: Record<ToolId, () => HTMLElement> = {
    ping: pingTool,
    trace: traceTool,
    ports: portScanTool,
    lan: () => lanScanTool(ifaces),
    dns: dnsTool,
    whois: whoisTool,
    wol: () => wolTool(ifaces),
    subnet: subnetTool,
    info: () => infoTool(ifaces),
  };
  // Each tool is built once and kept, so a running scan survives switching tabs.
  const built = new Map<ToolId, HTMLElement>();
  const body = h("div", { class: "tool-body" });
  const nav = h("div", { class: "tool-nav", role: "tablist" });
  const show = (id: ToolId) => {
    remember("tool", id);
    if (!built.has(id)) {
      const el = builders[id]();
      built.set(id, el);
      body.append(el);
    }
    for (const [k, el] of built) el.hidden = k !== id;
    nav.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.tool === id));
  };
  nav.append(...TOOLS.map(([id, label]) => h("button", { type: "button", role: "tab", "data-tool": id, onclick: () => show(id) }, label)));
  const initial = remembered("tool", "ping") as ToolId;
  show(TOOLS.some(([id]) => id === initial) ? initial : "ping");
  return h("div", { class: "tools-page" }, h("h2", { class: "tools-title" }, "🛠 Network tools"), nav, body);
}
