//! Network tools that work without root on Android/iOS: TCP "ping",
//! port scanning and DNS lookup.

use std::net::SocketAddr;
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::net::{lookup_host, TcpStream};
use tokio::task::JoinSet;

use crate::error::{Error, Result};

async fn resolve(host: &str, port: u16) -> Result<SocketAddr> {
    lookup_host((host, port))
        .await?
        .next()
        .ok_or_else(|| Error::msg(format!("Host tidak ditemukan: {host}")))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PingResult {
    seq: u32,
    ok: bool,
    ms: f64,
    error: Option<String>,
}

/// Measures TCP connect latency (ICMP ping needs root on mobile).
#[tauri::command]
pub async fn net_tcp_ping(
    host: String,
    port: u16,
    count: u32,
    timeout_ms: u64,
) -> Result<Vec<PingResult>> {
    let addr = resolve(&host, port).await?;
    let mut out = Vec::new();
    for seq in 1..=count.clamp(1, 50) {
        let start = Instant::now();
        let res =
            tokio::time::timeout(Duration::from_millis(timeout_ms), TcpStream::connect(addr)).await;
        let ms = start.elapsed().as_secs_f64() * 1000.0;
        let (ok, error) = match res {
            Ok(Ok(_)) => (true, None),
            Ok(Err(e)) => (false, Some(e.to_string())),
            Err(_) => (false, Some("timeout".into())),
        };
        out.push(PingResult { seq, ok, ms, error });
        if seq < count {
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
    }
    Ok(out)
}

#[derive(Serialize)]
pub struct PortResult {
    port: u16,
    open: bool,
}

/// Scans `ports` on `host` with limited concurrency. Returns open ports only.
#[tauri::command]
pub async fn net_port_scan(
    host: String,
    ports: Vec<u16>,
    timeout_ms: u64,
) -> Result<Vec<PortResult>> {
    let ip = resolve(&host, 0).await?.ip();
    let timeout = Duration::from_millis(timeout_ms.clamp(100, 10_000));
    let mut results = Vec::new();
    for chunk in ports.chunks(64) {
        let mut set = JoinSet::new();
        for &port in chunk {
            set.spawn(async move {
                let open = matches!(
                    tokio::time::timeout(timeout, TcpStream::connect(SocketAddr::new(ip, port)))
                        .await,
                    Ok(Ok(_))
                );
                PortResult { port, open }
            });
        }
        while let Some(r) = set.join_next().await {
            if let Ok(r) = r {
                if r.open {
                    results.push(r);
                }
            }
        }
    }
    results.sort_by_key(|r| r.port);
    Ok(results)
}

#[tauri::command]
pub async fn net_dns_lookup(host: String) -> Result<Vec<String>> {
    let mut ips: Vec<String> = lookup_host((host.as_str(), 0))
        .await?
        .map(|a| a.ip().to_string())
        .collect();
    ips.sort();
    ips.dedup();
    Ok(ips)
}
