// Typed wrappers around the Rust commands in src-tauri/src.
import { Channel, invoke } from "@tauri-apps/api/core";

export type TermEvent =
  | { type: "data"; data: string }
  | { type: "closed"; reason: string };

export interface ConnectRequest {
  requestId: string;
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  cols: number;
  rows: number;
  keepaliveSecs?: number;
}

export interface SftpEntry {
  name: string;
  path: string;
  isDir: boolean;
  isLink: boolean;
  size: number;
  mtime: number | null;
  permissions: number | null;
}

export interface TunnelInfo {
  id: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  connections: number;
}

export interface MonitorSample {
  hostname: string;
  kernel: string;
  os: string | null;
  cpuCount: number;
  cpuTotal: number;
  cpuIdle: number;
  memTotalKb: number;
  memAvailableKb: number;
  swapTotalKb: number;
  swapFreeKb: number;
  load: [number, number, number];
  tasksRunning: number;
  tasksTotal: number;
  uptimeSecs: number;
  users: number;
  net: { name: string; rxBytes: number; txBytes: number }[];
  disks: { filesystem: string; mount: string; totalKb: number; usedKb: number; availKb: number }[];
  processes: { pid: number; user: string; cpu: number; mem: number | null; command: string }[];
  processesLive: boolean;
}

export type PingEvent =
  | { type: "start"; ip: string; mode: string; note: string | null }
  | { type: "reply"; seq: number; ms: number }
  | { type: "timeout"; seq: number }
  | { type: "error"; seq: number; message: string };

export type TraceEvent =
  | { type: "start"; ip: string; maxHops: number }
  | { type: "hop"; ttl: number; ip: string | null; rtts: (number | null)[]; reached: boolean; note: string | null }
  | { type: "name"; ttl: number; name: string };

export type ScanEvent =
  | { type: "start"; ip: string; total: number }
  | { type: "open"; port: number; ms: number; banner: string | null }
  | { type: "progress"; done: number; total: number };

export type LanEvent =
  | { type: "start"; total: number; icmp: boolean; note: string | null }
  | { type: "host"; ip: string; ms: number | null; ports: number[]; via: string }
  | { type: "name"; ip: string; name: string }
  | { type: "progress"; done: number; total: number };

export interface IfaceInfo {
  name: string;
  ip: string;
  prefix: number;
  ipv6: boolean;
  loopback: boolean;
  network: string | null;
}

export interface HostKey {
  algorithm: string;
  fingerprint: string;
}

export const api = {
  profilesLoad: () => invoke<unknown>("profiles_load"),
  profilesSave: (profiles: unknown) => invoke<void>("profiles_save", { profiles }),

  sshConnect: (req: ConnectRequest, onEvent: Channel<TermEvent>) =>
    invoke<string>("ssh_connect", { req, onEvent }),
  sshWrite: (id: string, data: string) => invoke<void>("ssh_write", { id, data }),
  sshResize: (id: string, cols: number, rows: number) => invoke<void>("ssh_resize", { id, cols, rows }),
  sshExec: (id: string, command: string) =>
    invoke<{ stdout: string; stderr: string; exitCode: number | null }>("ssh_exec", { id, command }),
  sshDisconnect: (id: string) => invoke<void>("ssh_disconnect", { id }),
  hostkeyDecide: (requestId: string, accept: boolean) => invoke<void>("hostkey_decide", { requestId, accept }),
  knownHostsList: () => invoke<Record<string, HostKey>>("known_hosts_list"),
  knownHostsRemove: (host: string) => invoke<void>("known_hosts_remove", { host }),

  sftpList: (id: string, path?: string) =>
    invoke<{ path: string; entries: SftpEntry[] }>("sftp_list", { id, path }),
  sftpMkdir: (id: string, path: string) => invoke<void>("sftp_mkdir", { id, path }),
  sftpRemove: (id: string, path: string, isDir: boolean) => invoke<void>("sftp_remove", { id, path, isDir }),
  sftpRename: (id: string, from: string, to: string) => invoke<void>("sftp_rename", { id, from, to }),
  sftpChmod: (id: string, path: string, mode: number) => invoke<void>("sftp_chmod", { id, path, mode }),
  sftpRead: (id: string, path: string) => invoke<string>("sftp_read", { id, path }),
  sftpWrite: (id: string, path: string, data: string) => invoke<void>("sftp_write", { id, path, data }),
  sftpDownload: (id: string, path: string) => invoke<string>("sftp_download", { id, path }),
  sftpCreate: (id: string, path: string) => invoke<void>("sftp_create", { id, path }),
  sftpStat: (id: string, path: string) =>
    invoke<{ size: number; mtime: number | null; permissions: number | null; isDir: boolean }>("sftp_stat", { id, path }),

  tunnelStart: (id: string, localPort: number, remoteHost: string, remotePort: number) =>
    invoke<TunnelInfo>("tunnel_start", { id, localPort, remoteHost, remotePort }),
  tunnelList: (id: string) => invoke<TunnelInfo[]>("tunnel_list", { id }),
  tunnelStop: (id: string, tunnelId: string) => invoke<void>("tunnel_stop", { id, tunnelId }),

  monitorSample: (id: string) => invoke<MonitorSample>("monitor_sample", { id }),

  netCancel: (jobId: string) => invoke<void>("net_cancel", { jobId }),
  netPing: (
    jobId: string,
    host: string,
    count: number,
    intervalMs: number,
    timeoutMs: number,
    tcpPort: number,
    onEvent: Channel<PingEvent>,
  ) => invoke<void>("net_ping", { jobId, host, count, intervalMs, timeoutMs, tcpPort, onEvent }),
  netTraceroute: (jobId: string, host: string, maxHops: number, timeoutMs: number, onEvent: Channel<TraceEvent>) =>
    invoke<void>("net_traceroute", { jobId, host, maxHops, timeoutMs, onEvent }),
  netPortScan: (
    jobId: string,
    host: string,
    ports: number[],
    timeoutMs: number,
    concurrency: number,
    banners: boolean,
    onEvent: Channel<ScanEvent>,
  ) => invoke<void>("net_port_scan", { jobId, host, ports, timeoutMs, concurrency, banners, onEvent }),
  netLanScan: (jobId: string, cidr: string, timeoutMs: number, onEvent: Channel<LanEvent>) =>
    invoke<void>("net_lan_scan", { jobId, cidr, timeoutMs, onEvent }),
  netInterfaces: () => invoke<IfaceInfo[]>("net_interfaces"),
  netDnsQuery: (name: string, rtype: string, server: string) =>
    invoke<{ server: string; ms: number; records: { name: string; rtype: string; ttl: number; data: string }[] }>(
      "net_dns_query",
      { name, rtype, server },
    ),
  netWhois: (query: string) => invoke<string>("net_whois", { query }),
  netWol: (mac: string, broadcast: string, port: number) => invoke<void>("net_wol", { mac, broadcast, port }),
};

// Base64 helpers for binary-safe transfer between Rust and the webview.
export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
