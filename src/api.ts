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

  tunnelStart: (id: string, localPort: number, remoteHost: string, remotePort: number) =>
    invoke<TunnelInfo>("tunnel_start", { id, localPort, remoteHost, remotePort }),
  tunnelList: (id: string) => invoke<TunnelInfo[]>("tunnel_list", { id }),
  tunnelStop: (id: string, tunnelId: string) => invoke<void>("tunnel_stop", { id, tunnelId }),

  tcpPing: (host: string, port: number, count: number, timeoutMs: number) =>
    invoke<{ seq: number; ok: boolean; ms: number; error: string | null }[]>("net_tcp_ping", {
      host,
      port,
      count,
      timeoutMs,
    }),
  portScan: (host: string, ports: number[], timeoutMs: number) =>
    invoke<{ port: number; open: boolean }[]>("net_port_scan", { host, ports, timeoutMs }),
  dnsLookup: (host: string) => invoke<string[]>("net_dns_lookup", { host }),
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
