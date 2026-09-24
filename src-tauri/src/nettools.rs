//! Network tools (MobaXterm "Tools → Network"): ping, traceroute, port
//! scanner, LAN scanner, DNS, whois, Wake-on-LAN and interface info. All of
//! them work without root on Android/iOS. Long-running tools stream results
//! through a Tauri channel and can be cancelled by job id.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{lookup_host, TcpStream, UdpSocket};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use crate::error::{Error, Result};
use crate::icmp;

// ------------------------------------------------------------------ jobs

/// Cancellation flags of running tools, keyed by a frontend-chosen job id.
#[derive(Default)]
pub struct Jobs(Mutex<HashMap<String, Arc<AtomicBool>>>);

struct JobGuard<'a> {
    jobs: &'a Jobs,
    id: String,
    flag: Arc<AtomicBool>,
}

impl JobGuard<'_> {
    fn cancelled(&self) -> bool {
        self.flag.load(Ordering::Relaxed)
    }
}

impl Drop for JobGuard<'_> {
    fn drop(&mut self) {
        self.jobs.0.lock().unwrap().remove(&self.id);
    }
}

impl Jobs {
    fn start(&self, id: &str) -> JobGuard<'_> {
        let flag = Arc::new(AtomicBool::new(false));
        self.0.lock().unwrap().insert(id.to_string(), flag.clone());
        JobGuard {
            jobs: self,
            id: id.to_string(),
            flag,
        }
    }
}

#[tauri::command]
pub fn net_cancel(jobs: State<'_, Jobs>, job_id: String) {
    if let Some(flag) = jobs.0.lock().unwrap().get(&job_id) {
        flag.store(true, Ordering::Relaxed);
    }
}

// ------------------------------------------------------------------ helpers

async fn resolve(host: &str, port: u16) -> Result<SocketAddr> {
    let addrs: Vec<SocketAddr> = lookup_host((host.trim(), port)).await?.collect();
    // Prefer IPv4: ICMP tools are IPv4-only and most LANs are too.
    addrs
        .iter()
        .find(|a| a.is_ipv4())
        .or(addrs.first())
        .copied()
        .ok_or_else(|| Error::msg(format!("Host tidak ditemukan: {host}")))
}

async fn resolve_v4(host: &str) -> Result<Ipv4Addr> {
    match resolve(host, 0).await?.ip() {
        IpAddr::V4(ip) => Ok(ip),
        IpAddr::V6(_) => Err(Error::msg("Hanya IPv4 yang didukung untuk alat ICMP")),
    }
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

/// Reverse DNS through the platform resolver (knows LAN names on Android/iOS).
async fn reverse_name(ip: IpAddr, timeout: Duration) -> Option<String> {
    let task = tokio::task::spawn_blocking(move || dns_lookup::lookup_addr(&ip).ok());
    let name = tokio::time::timeout(timeout, task).await.ok()?.ok()??;
    (name != ip.to_string()).then_some(name)
}

// ------------------------------------------------------------------ ping

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PingEvent {
    #[serde(rename_all = "camelCase")]
    Start {
        ip: String,
        mode: String,
        note: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Reply { seq: u32, ms: f64 },
    #[serde(rename_all = "camelCase")]
    Timeout { seq: u32 },
    #[serde(rename_all = "camelCase")]
    Error { seq: u32, message: String },
}

/// ICMP ping; falls back to TCP connect timing (to `tcp_port`) when ping
/// sockets are not permitted or the target is IPv6.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn net_ping(
    jobs: State<'_, Jobs>,
    job_id: String,
    host: String,
    count: u32,
    interval_ms: u64,
    timeout_ms: u64,
    tcp_port: u16,
    on_event: Channel<PingEvent>,
) -> Result<()> {
    let job = jobs.start(&job_id);
    let addr = resolve(&host, tcp_port).await?;
    let timeout = Duration::from_millis(timeout_ms.clamp(200, 10_000));
    let interval = Duration::from_millis(interval_ms.clamp(200, 10_000));
    let count = count.clamp(1, 1000);

    let icmp_sock = match addr.ip() {
        IpAddr::V4(ip) => match icmp::open().and_then(|s| icmp::connect(&s, ip).map(|_| s)) {
            Ok(s) => Ok(s),
            Err(e) => Err(icmp::unavailable_reason(&e)),
        },
        IpAddr::V6(_) => Err("Target IPv6".to_string()),
    };
    let (mode, note) = match &icmp_sock {
        Ok(_) => ("ICMP".to_string(), None),
        Err(why) => (
            format!("TCP :{tcp_port}"),
            Some(format!("{why} — memakai TCP connect")),
        ),
    };
    let _ = on_event.send(PingEvent::Start {
        ip: addr.ip().to_string(),
        mode,
        note,
    });
    let sock = icmp_sock.ok().map(Arc::new);

    for seq in 1..=count {
        if job.cancelled() {
            break;
        }
        let started = Instant::now();
        let event = match &sock {
            Some(sock) => {
                let sock = sock.clone();
                let res = tokio::task::spawn_blocking(move || {
                    icmp::ping_once(&sock, seq as u16, timeout)
                })
                .await
                .map_err(|e| Error::msg(e.to_string()))?;
                match res {
                    Ok(Some(rtt)) => PingEvent::Reply { seq, ms: ms(rtt) },
                    Ok(None) => PingEvent::Timeout { seq },
                    Err(e) => PingEvent::Error {
                        seq,
                        message: e.to_string(),
                    },
                }
            }
            None => match tokio::time::timeout(timeout, TcpStream::connect(addr)).await {
                Ok(Ok(_)) => PingEvent::Reply {
                    seq,
                    ms: ms(started.elapsed()),
                },
                // A refused connection still proves the host answered.
                Ok(Err(e)) if e.kind() == std::io::ErrorKind::ConnectionRefused => {
                    PingEvent::Reply {
                        seq,
                        ms: ms(started.elapsed()),
                    }
                }
                Ok(Err(e)) => PingEvent::Error {
                    seq,
                    message: e.to_string(),
                },
                Err(_) => PingEvent::Timeout { seq },
            },
        };
        let _ = on_event.send(event);
        if seq < count {
            let wait = interval.saturating_sub(started.elapsed());
            let step = Duration::from_millis(100);
            let until = Instant::now() + wait;
            while Instant::now() < until && !job.cancelled() {
                tokio::time::sleep(step.min(until - Instant::now())).await;
            }
        }
    }
    Ok(())
}

// ------------------------------------------------------------------ traceroute

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TraceEvent {
    #[serde(rename_all = "camelCase")]
    Start { ip: String, max_hops: u32 },
    #[serde(rename_all = "camelCase")]
    Hop {
        ttl: u32,
        ip: Option<String>,
        rtts: Vec<Option<f64>>,
        reached: bool,
        note: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Name { ttl: u32, name: String },
}

#[cfg(any(target_os = "linux", target_os = "android"))]
#[tauri::command]
pub async fn net_traceroute(
    jobs: State<'_, Jobs>,
    job_id: String,
    host: String,
    max_hops: u32,
    timeout_ms: u64,
    on_event: Channel<TraceEvent>,
) -> Result<()> {
    let job = jobs.start(&job_id);
    let dest = resolve_v4(&host).await?;
    let max_hops = max_hops.clamp(1, 64);
    let timeout = Duration::from_millis(timeout_ms.clamp(200, 5000));
    let sock = icmp::open()
        .and_then(|s| icmp::connect(&s, dest).map(|_| s))
        .and_then(|s| icmp::enable_recverr(&s).map(|_| s))
        .map_err(|e| Error::msg(icmp::unavailable_reason(&e)))?;
    let sock = Arc::new(sock);
    let _ = on_event.send(TraceEvent::Start {
        ip: dest.to_string(),
        max_hops,
    });

    let mut names = JoinSet::new();
    for ttl in 1..=max_hops {
        if job.cancelled() {
            break;
        }
        let s = sock.clone();
        let probes = tokio::task::spawn_blocking(move || {
            (0..3u16)
                .map(|p| icmp::trace_probe(&s, ttl, (ttl as u16) * 4 + p, timeout))
                .collect::<Vec<_>>()
        })
        .await
        .map_err(|e| Error::msg(e.to_string()))?;

        let (mut hop_ip, mut reached, mut note, mut rtts) = (None, false, None, Vec::new());
        for probe in probes {
            match probe? {
                icmp::ProbeResult::Hop {
                    from,
                    rtt,
                    kind,
                    code,
                } => {
                    hop_ip = Some(IpAddr::V4(from));
                    rtts.push(Some(ms(rtt)));
                    if kind == icmp::DEST_UNREACHABLE {
                        reached = true;
                        note = Some(format!("tidak terjangkau (kode {code})"));
                    }
                }
                icmp::ProbeResult::Reached { rtt } => {
                    hop_ip = Some(IpAddr::V4(dest));
                    reached = true;
                    rtts.push(Some(ms(rtt)));
                }
                icmp::ProbeResult::Timeout => rtts.push(None),
            }
        }
        let _ = on_event.send(TraceEvent::Hop {
            ttl,
            ip: hop_ip.map(|ip| ip.to_string()),
            rtts,
            reached,
            note,
        });
        if let Some(ip) = hop_ip {
            let ch = on_event.clone();
            names.spawn(async move {
                if let Some(name) = reverse_name(ip, Duration::from_secs(3)).await {
                    let _ = ch.send(TraceEvent::Name { ttl, name });
                }
            });
        }
        if reached {
            break;
        }
    }
    while names.join_next().await.is_some() {}
    Ok(())
}

#[cfg(not(any(target_os = "linux", target_os = "android")))]
#[tauri::command]
pub async fn net_traceroute(
    _jobs: State<'_, Jobs>,
    _job_id: String,
    _host: String,
    _max_hops: u32,
    _timeout_ms: u64,
    _on_event: Channel<TraceEvent>,
) -> Result<()> {
    Err(Error::msg("Traceroute hanya tersedia di Android dan Linux"))
}

// ------------------------------------------------------------------ port scan

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ScanEvent {
    #[serde(rename_all = "camelCase")]
    Start { ip: String, total: u32 },
    #[serde(rename_all = "camelCase")]
    Open {
        port: u16,
        ms: f64,
        banner: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Progress { done: u32, total: u32 },
}

/// Reads what the service volunteers on connect (SSH/FTP/SMTP greet first).
async fn grab_banner(stream: &mut TcpStream) -> Option<String> {
    let mut buf = [0u8; 256];
    let n = tokio::time::timeout(Duration::from_millis(700), stream.read(&mut buf))
        .await
        .ok()?
        .ok()?;
    let text: String = String::from_utf8_lossy(&buf[..n])
        .chars()
        .filter(|c| !c.is_control() || *c == ' ')
        .collect();
    let text = text.trim().to_string();
    (!text.is_empty()).then_some(text)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn net_port_scan(
    jobs: State<'_, Jobs>,
    job_id: String,
    host: String,
    ports: Vec<u16>,
    timeout_ms: u64,
    concurrency: usize,
    banners: bool,
    on_event: Channel<ScanEvent>,
) -> Result<()> {
    let job = jobs.start(&job_id);
    let ip = resolve(&host, 0).await?.ip();
    let timeout = Duration::from_millis(timeout_ms.clamp(100, 10_000));
    let total = ports.len() as u32;
    let _ = on_event.send(ScanEvent::Start {
        ip: ip.to_string(),
        total,
    });

    let sem = Arc::new(Semaphore::new(concurrency.clamp(1, 512)));
    let mut set = JoinSet::new();
    let mut done = 0u32;
    let mut last_progress = Instant::now();
    for port in ports {
        if job.cancelled() {
            break;
        }
        let permit = sem.clone().acquire_owned().await.expect("semaphore open");
        let ch = on_event.clone();
        set.spawn(async move {
            let _permit = permit;
            let start = Instant::now();
            if let Ok(Ok(mut stream)) =
                tokio::time::timeout(timeout, TcpStream::connect(SocketAddr::new(ip, port))).await
            {
                let rtt = ms(start.elapsed());
                let banner = if banners {
                    grab_banner(&mut stream).await
                } else {
                    None
                };
                let _ = ch.send(ScanEvent::Open {
                    port,
                    ms: rtt,
                    banner,
                });
            }
        });
        while let Some(r) = set.try_join_next() {
            let _ = r;
            done += 1;
        }
        if last_progress.elapsed() > Duration::from_millis(250) {
            last_progress = Instant::now();
            let _ = on_event.send(ScanEvent::Progress { done, total });
        }
    }
    while set.join_next().await.is_some() {
        done += 1;
    }
    let _ = on_event.send(ScanEvent::Progress { done, total });
    Ok(())
}

// ------------------------------------------------------------------ LAN scan

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum LanEvent {
    #[serde(rename_all = "camelCase")]
    Start {
        total: u32,
        icmp: bool,
        note: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Host {
        ip: String,
        ms: Option<f64>,
        ports: Vec<u16>,
        via: String,
    },
    #[serde(rename_all = "camelCase")]
    Name { ip: String, name: String },
    #[serde(rename_all = "camelCase")]
    Progress { done: u32, total: u32 },
}

/// Hosts of an IPv4 CIDR (network and broadcast excluded for prefixes < 31).
pub fn cidr_hosts(cidr: &str) -> Result<Vec<Ipv4Addr>> {
    let (ip, prefix) = cidr.trim().split_once('/').unwrap_or((cidr.trim(), "24"));
    let ip: Ipv4Addr = ip
        .parse()
        .map_err(|_| Error::msg("Alamat IPv4 tidak valid"))?;
    let prefix: u32 = prefix
        .parse()
        .map_err(|_| Error::msg("Prefix tidak valid"))?;
    if !(20..=32).contains(&prefix) {
        return Err(Error::msg("Prefix harus /20 sampai /32 (maks. 4096 host)"));
    }
    let mask = if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - prefix)
    };
    let net = u32::from(ip) & mask;
    let bcast = net | !mask;
    let range = if prefix >= 31 {
        net..=bcast
    } else {
        net + 1..=bcast - 1
    };
    Ok(range.map(Ipv4Addr::from).collect())
}

/// Ports probed to find hosts that ignore ping; a refused connection (RST)
/// also proves the host is up.
const LAN_PROBE_PORTS: &[u16] = &[
    80, 443, 22, 445, 139, 8080, 3389, 53, 5000, 62078, 7000, 9100,
];

#[tauri::command]
pub async fn net_lan_scan(
    jobs: State<'_, Jobs>,
    job_id: String,
    cidr: String,
    timeout_ms: u64,
    on_event: Channel<LanEvent>,
) -> Result<()> {
    let job = jobs.start(&job_id);
    let hosts = cidr_hosts(&cidr)?;
    let total = hosts.len() as u32;
    let timeout = Duration::from_millis(timeout_ms.clamp(100, 5000));

    // Phase 1: one ICMP sweep over the whole range.
    let sweep_hosts = hosts.clone();
    let sweep =
        tokio::task::spawn_blocking(move || icmp::sweep(&sweep_hosts, Duration::from_millis(1500)))
            .await
            .map_err(|e| Error::msg(e.to_string()))?;
    let (icmp_alive, note) = match sweep {
        Ok(alive) => (Some(alive), None),
        Err(e) => (
            None,
            Some(format!(
                "{} — deteksi hanya lewat TCP",
                icmp::unavailable_reason(&e)
            )),
        ),
    };
    let _ = on_event.send(LanEvent::Start {
        total,
        icmp: icmp_alive.is_some(),
        note,
    });
    let icmp_alive = icmp_alive.unwrap_or_default();
    for (ip, rtt) in &icmp_alive {
        let _ = on_event.send(LanEvent::Host {
            ip: ip.to_string(),
            ms: Some(ms(*rtt)),
            ports: vec![],
            via: "icmp".into(),
        });
    }

    // Phase 2: TCP probes on every host (finds firewalled hosts + open ports).
    let sem = Arc::new(Semaphore::new(48));
    let mut set = JoinSet::new();
    let mut done = 0u32;
    for ip in hosts {
        if job.cancelled() {
            break;
        }
        let permit = sem.clone().acquire_owned().await.expect("semaphore open");
        let known = icmp_alive.get(&ip).copied();
        set.spawn(async move {
            let _permit = permit;
            let mut probes = JoinSet::new();
            for &port in LAN_PROBE_PORTS {
                probes.spawn(async move {
                    let start = Instant::now();
                    let r = tokio::time::timeout(
                        timeout,
                        TcpStream::connect(SocketAddr::new(IpAddr::V4(ip), port)),
                    )
                    .await;
                    match r {
                        Ok(Ok(_)) => Some((port, true, start.elapsed())),
                        Ok(Err(e)) if e.kind() == std::io::ErrorKind::ConnectionRefused => {
                            Some((port, false, start.elapsed()))
                        }
                        _ => None,
                    }
                });
            }
            let (mut open, mut seen, mut best) = (Vec::new(), known.is_some(), known);
            while let Some(Ok(Some((port, is_open, rtt)))) = probes.join_next().await {
                seen = true;
                best = Some(best.map_or(rtt, |b| b.min(rtt)));
                if is_open {
                    open.push(port);
                }
            }
            open.sort_unstable();
            (ip, seen, best, open, known.is_some())
        });
        while let Some(r) = set.try_join_next() {
            done += 1;
            if let Ok((ip, true, best, ports, by_icmp)) = r {
                if !by_icmp || !ports.is_empty() {
                    let via = if by_icmp { "icmp" } else { "tcp" }.to_string();
                    let _ = on_event.send(LanEvent::Host {
                        ip: ip.to_string(),
                        ms: best.map(ms),
                        ports,
                        via,
                    });
                }
            }
        }
        if done.is_multiple_of(16) {
            let _ = on_event.send(LanEvent::Progress { done, total });
        }
    }
    let mut alive = icmp_alive.keys().copied().collect::<Vec<_>>();
    while let Some(r) = set.join_next().await {
        done += 1;
        if let Ok((ip, true, best, ports, by_icmp)) = r {
            if !by_icmp {
                alive.push(ip);
            }
            if !by_icmp || !ports.is_empty() {
                let via = if by_icmp { "icmp" } else { "tcp" }.to_string();
                let _ = on_event.send(LanEvent::Host {
                    ip: ip.to_string(),
                    ms: best.map(ms),
                    ports,
                    via,
                });
            }
        }
    }
    let _ = on_event.send(LanEvent::Progress { done, total });

    // Phase 3: names of the hosts found.
    let mut names = JoinSet::new();
    let sem = Arc::new(Semaphore::new(8));
    for ip in alive {
        let (ch, sem) = (on_event.clone(), sem.clone());
        names.spawn(async move {
            let _p = sem.acquire_owned().await;
            if let Some(name) = reverse_name(IpAddr::V4(ip), Duration::from_secs(2)).await {
                let _ = ch.send(LanEvent::Name {
                    ip: ip.to_string(),
                    name,
                });
            }
        });
    }
    while names.join_next().await.is_some() {}
    Ok(())
}

// ------------------------------------------------------------------ interfaces

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IfaceInfo {
    name: String,
    ip: String,
    prefix: u8,
    ipv6: bool,
    loopback: bool,
    /// Network in CIDR form, e.g. 192.168.1.0/24.
    network: Option<String>,
}

#[tauri::command]
pub fn net_interfaces() -> Result<Vec<IfaceInfo>> {
    let mut out: Vec<IfaceInfo> = if_addrs::get_if_addrs()?
        .into_iter()
        .map(|i| {
            let loopback = i.is_loopback();
            match i.addr {
                if_addrs::IfAddr::V4(a) => {
                    let mask = u32::from(a.netmask);
                    let net = Ipv4Addr::from(u32::from(a.ip) & mask);
                    IfaceInfo {
                        name: i.name,
                        ip: a.ip.to_string(),
                        prefix: a.prefixlen,
                        ipv6: false,
                        loopback,
                        network: Some(format!("{net}/{}", a.prefixlen)),
                    }
                }
                if_addrs::IfAddr::V6(a) => IfaceInfo {
                    name: i.name,
                    ip: a.ip.to_string(),
                    prefix: a.prefixlen,
                    ipv6: true,
                    loopback,
                    network: None,
                },
            }
        })
        .collect();
    out.sort_by_key(|i| (i.loopback, i.ipv6, i.name.clone()));
    Ok(out)
}

// ------------------------------------------------------------------ DNS

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DnsRecord {
    name: String,
    rtype: String,
    ttl: u32,
    data: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DnsAnswer {
    server: String,
    ms: f64,
    records: Vec<DnsRecord>,
}

/// DNS query of any record type against `server` (an IP). An IP as `name`
/// becomes a PTR query. `server = "system"` uses the platform resolver,
/// which only answers A/AAAA/PTR.
#[tauri::command]
pub async fn net_dns_query(name: String, rtype: String, server: String) -> Result<DnsAnswer> {
    use hickory_resolver::config::{NameServerConfig, ResolveHosts, ResolverConfig};
    use hickory_resolver::net::runtime::TokioRuntimeProvider;
    use hickory_resolver::proto::rr::{Name, RecordType};
    use hickory_resolver::Resolver;

    let name = name.trim().trim_end_matches('.').to_string();
    if name.is_empty() {
        return Err(Error::msg("Isi nama domain atau IP"));
    }
    let start = Instant::now();
    let ip: Option<IpAddr> = name.parse().ok();

    if server == "system" {
        let records = match ip {
            Some(ip) => reverse_name(ip, Duration::from_secs(5))
                .await
                .map(|n| {
                    vec![DnsRecord {
                        name: name.clone(),
                        rtype: "PTR".into(),
                        ttl: 0,
                        data: n,
                    }]
                })
                .unwrap_or_default(),
            None => {
                let mut ips: Vec<IpAddr> = lookup_host((name.as_str(), 0))
                    .await?
                    .map(|a| a.ip())
                    .collect();
                ips.sort();
                ips.dedup();
                ips.into_iter()
                    .map(|ip| DnsRecord {
                        name: name.clone(),
                        rtype: if ip.is_ipv4() { "A" } else { "AAAA" }.into(),
                        ttl: 0,
                        data: ip.to_string(),
                    })
                    .collect()
            }
        };
        return Ok(DnsAnswer {
            server: "resolver sistem".into(),
            ms: ms(start.elapsed()),
            records,
        });
    }

    let server_ip: IpAddr = server
        .trim()
        .parse()
        .map_err(|_| Error::msg("Alamat server DNS tidak valid"))?;
    let config = ResolverConfig::from_name_servers(vec![NameServerConfig::udp_and_tcp(server_ip)]);
    let mut builder = Resolver::builder_with_config(config, TokioRuntimeProvider::default());
    builder.options_mut().timeout = Duration::from_secs(4);
    builder.options_mut().attempts = 2;
    // Ask the chosen server only; never answer from the local hosts file.
    builder.options_mut().use_hosts_file = ResolveHosts::Never;
    let resolver = builder.build().map_err(|e| Error::msg(e.to_string()))?;

    let (qname, rtype) = match ip {
        Some(ip) => (Name::from(ip), RecordType::PTR),
        None => {
            let rt: RecordType = rtype
                .to_uppercase()
                .parse()
                .map_err(|_| Error::msg("Tipe record tidak dikenal"))?;
            let mut n = Name::from_ascii(&name).map_err(|e| Error::msg(e.to_string()))?;
            n.set_fqdn(true);
            (n, rt)
        }
    };
    let records = match resolver.lookup(qname, rtype).await {
        Ok(lookup) => lookup
            .answers()
            .iter()
            .map(|r| DnsRecord {
                name: r.name.to_string(),
                rtype: r.record_type().to_string(),
                ttl: r.ttl,
                data: r.data.to_string(),
            })
            .collect(),
        Err(e) if e.to_string().to_lowercase().contains("no record") => Vec::new(),
        Err(e) => return Err(Error::msg(format!("DNS: {e}"))),
    };
    Ok(DnsAnswer {
        server: server_ip.to_string(),
        ms: ms(start.elapsed()),
        records,
    })
}

// ------------------------------------------------------------------ whois

async fn whois_query(server: &str, query: &str) -> Result<String> {
    let io = async {
        let mut stream = TcpStream::connect((server, 43)).await?;
        stream.write_all(format!("{query}\r\n").as_bytes()).await?;
        let mut out = Vec::new();
        stream.take(128 * 1024).read_to_end(&mut out).await?;
        Ok::<_, std::io::Error>(String::from_utf8_lossy(&out).into_owned())
    };
    tokio::time::timeout(Duration::from_secs(10), io)
        .await
        .map_err(|_| Error::msg(format!("Timeout menghubungi {server}")))?
        .map_err(|e| Error::msg(format!("{server}: {e}")))
}

/// Finds the next whois server a response refers to.
pub fn whois_referral(text: &str, current: &str) -> Option<String> {
    const KEYS: &[&str] = &[
        "refer:",
        "whois:",
        "registrar whois server:",
        "referralserver:",
    ];
    text.lines().find_map(|line| {
        let l = line.trim();
        let lower = l.to_lowercase();
        let key = KEYS.iter().find(|k| lower.starts_with(*k))?;
        let value = l[key.len()..]
            .trim()
            .trim_start_matches("whois://")
            .trim_end_matches('/');
        let host = value.split(':').next()?.trim().to_lowercase();
        (!host.is_empty() && host.contains('.') && host != current).then_some(host)
    })
}

#[tauri::command]
pub async fn net_whois(query: String) -> Result<String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Err(Error::msg("Isi domain atau IP"));
    }
    let mut server = "whois.iana.org".to_string();
    let mut out = String::new();
    for _ in 0..3 {
        let text = whois_query(&server, &query).await?;
        out.push_str(&format!("### {server}\n{}\n", text.trim()));
        match whois_referral(&text, &server) {
            Some(next) => server = next,
            None => break,
        }
    }
    Ok(out)
}

// ------------------------------------------------------------------ Wake-on-LAN

pub fn parse_mac(mac: &str) -> Result<[u8; 6]> {
    let hex: String = mac.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    if hex.len() != 12
        || mac
            .chars()
            .any(|c| !(c.is_ascii_hexdigit() || ":-. ".contains(c)))
    {
        return Err(Error::msg(
            "Format MAC tidak valid (contoh AA:BB:CC:DD:EE:FF)",
        ));
    }
    let mut out = [0u8; 6];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).expect("validated hex");
    }
    Ok(out)
}

pub fn magic_packet(mac: [u8; 6]) -> Vec<u8> {
    let mut pkt = vec![0xff; 6];
    for _ in 0..16 {
        pkt.extend_from_slice(&mac);
    }
    pkt
}

#[tauri::command]
pub async fn net_wol(mac: String, broadcast: String, port: u16) -> Result<()> {
    let mac = parse_mac(&mac)?;
    let target: Ipv4Addr = broadcast
        .trim()
        .parse()
        .map_err(|_| Error::msg("Alamat broadcast tidak valid"))?;
    let sock = UdpSocket::bind("0.0.0.0:0").await?;
    sock.set_broadcast(true)?;
    let pkt = magic_packet(mac);
    // Send a few times: WoL is fire-and-forget over UDP.
    for _ in 0..3 {
        sock.send_to(&pkt, (target, port)).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cidr_expansion() {
        let h = cidr_hosts("192.168.1.77/24").unwrap();
        assert_eq!(h.len(), 254);
        assert_eq!(h[0], Ipv4Addr::new(192, 168, 1, 1));
        assert_eq!(*h.last().unwrap(), Ipv4Addr::new(192, 168, 1, 254));
        assert_eq!(
            cidr_hosts("10.0.0.5/32").unwrap(),
            vec![Ipv4Addr::new(10, 0, 0, 5)]
        );
        assert_eq!(cidr_hosts("10.0.0.4/31").unwrap().len(), 2);
        assert_eq!(cidr_hosts("10.0.0.0/20").unwrap().len(), 4094);
        assert!(cidr_hosts("10.0.0.0/16").is_err());
        assert_eq!(
            cidr_hosts("172.16.5.9").unwrap().len(),
            254,
            "defaults to /24"
        );
    }

    #[test]
    fn mac_and_magic_packet() {
        let mac = parse_mac("aa-bb-cc-dd-ee-0f").unwrap();
        assert_eq!(mac, [0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0x0f]);
        assert_eq!(parse_mac("AABB.CCDD.EE0F").unwrap(), mac);
        assert!(parse_mac("aa:bb:cc").is_err());
        assert!(parse_mac("zz:bb:cc:dd:ee:ff").is_err());
        let pkt = magic_packet(mac);
        assert_eq!(pkt.len(), 102);
        assert_eq!(&pkt[..6], &[0xff; 6]);
        assert_eq!(&pkt[96..], &mac);
    }

    #[test]
    fn whois_referrals() {
        let iana =
            "% IANA WHOIS server\n\ndomain:       COM\n\nrefer:        whois.verisign-grs.com\n";
        assert_eq!(
            whois_referral(iana, "whois.iana.org").as_deref(),
            Some("whois.verisign-grs.com")
        );
        let thin = "   Domain Name: EXAMPLE.COM\n   Registrar WHOIS Server: whois.iana.org\n";
        assert_eq!(
            whois_referral(thin, "whois.verisign-grs.com").as_deref(),
            Some("whois.iana.org")
        );
        assert_eq!(
            whois_referral(thin, "whois.iana.org"),
            None,
            "no self-referral loop"
        );
        let arin = "ReferralServer:  whois://whois.ripe.net\n";
        assert_eq!(
            whois_referral(arin, "whois.arin.net").as_deref(),
            Some("whois.ripe.net")
        );
    }
}
