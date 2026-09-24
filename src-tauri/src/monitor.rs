//! Remote resource monitor (like MobaXterm's remote-monitoring bar): one
//! shell script collects raw /proc data over an exec channel and it is parsed
//! here. Rates (CPU %, network throughput) are derived by the frontend from
//! two consecutive samples.

use std::time::Duration;

use serde::Serialize;
use tauri::State;

use crate::error::{Error, Result};
use crate::ssh::{run_exec, AppState};

/// Sent on stdin to `sh -s`, so it never depends on the user's login shell
/// or on quoting. Every section starts with an `@@name` marker line.
const SCRIPT: &str = r#"export LC_ALL=C
echo @@stat; head -n 1 /proc/stat 2>/dev/null
echo @@cpus; grep -c '^processor' /proc/cpuinfo 2>/dev/null
echo @@mem; cat /proc/meminfo 2>/dev/null
echo @@net; cat /proc/net/dev 2>/dev/null
echo @@load; cat /proc/loadavg 2>/dev/null
echo @@uptime; cat /proc/uptime 2>/dev/null
echo @@df; df -kP 2>/dev/null
echo @@host; (hostname 2>/dev/null || cat /proc/sys/kernel/hostname 2>/dev/null)
echo @@kernel; uname -sr 2>/dev/null
echo @@os; (. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME")
echo @@users; who 2>/dev/null | wc -l
echo @@procs
# procps top gives instant CPU% (2nd frame); otherwise fall back to ps.
procs=$(top -b -n 2 -d 0.5 -o %CPU -w 512 2>/dev/null | awk '/^top -/{n++} n==2' | head -n 20)
if [ -n "$procs" ]; then echo "$procs"; else ps -eo pid,user,pcpu,pmem,comm --sort=-pcpu 2>/dev/null | head -n 11; fi
"#;

#[derive(Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NetIf {
    pub name: String,
    pub rx_bytes: u64,
    pub tx_bytes: u64,
}

#[derive(Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Disk {
    pub filesystem: String,
    pub mount: String,
    pub total_kb: u64,
    pub used_kb: u64,
    pub avail_kb: u64,
}

#[derive(Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Process {
    pub pid: u32,
    pub user: String,
    pub cpu: f64,
    pub mem: Option<f64>,
    pub command: String,
}

#[derive(Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    pub hostname: String,
    pub kernel: String,
    pub os: Option<String>,
    pub cpu_count: u32,
    /// Aggregate jiffies from the `cpu` line of /proc/stat.
    pub cpu_total: u64,
    /// Idle + iowait jiffies.
    pub cpu_idle: u64,
    pub mem_total_kb: u64,
    pub mem_available_kb: u64,
    pub swap_total_kb: u64,
    pub swap_free_kb: u64,
    pub load: [f64; 3],
    pub tasks_running: u32,
    pub tasks_total: u32,
    pub uptime_secs: f64,
    pub users: u32,
    pub net: Vec<NetIf>,
    pub disks: Vec<Disk>,
    pub processes: Vec<Process>,
    /// True when `processes` comes from `top` (instant CPU %); `ps` reports
    /// the average since each process started.
    pub processes_live: bool,
}

fn sections(out: &str) -> Vec<(&str, Vec<&str>)> {
    let mut result: Vec<(&str, Vec<&str>)> = Vec::new();
    for line in out.lines() {
        if let Some(name) = line.strip_prefix("@@") {
            result.push((name.trim(), Vec::new()));
        } else if let Some((_, lines)) = result.last_mut() {
            lines.push(line);
        }
    }
    result
}

fn num<T: std::str::FromStr + Default>(s: &str) -> T {
    s.trim().parse().unwrap_or_default()
}

const PSEUDO_FS: &[&str] = &[
    "tmpfs",
    "devtmpfs",
    "udev",
    "none",
    "shm",
    "efivarfs",
    "overlay_tmp",
];

fn keep_disk(fs: &str, mount: &str) -> bool {
    if mount == "/" {
        return true;
    }
    let pseudo_mount = ["/proc", "/sys", "/dev", "/run", "/snap/", "/var/lib/docker"]
        .iter()
        .any(|p| mount.starts_with(p));
    !PSEUDO_FS.contains(&fs) && !pseudo_mount && !fs.starts_with("/dev/loop")
}

/// Parses a `top -b` or `ps` process table by its header, so both procps and
/// other layouts work as long as PID/USER/%CPU/COMMAND columns exist.
fn parse_processes(lines: &[&str]) -> (Vec<Process>, bool) {
    let Some(hdr_idx) = lines.iter().rposition(|l| {
        let t = l.split_whitespace().collect::<Vec<_>>();
        t.first() == Some(&"PID") && t.iter().any(|c| c.contains("CPU"))
    }) else {
        return (Vec::new(), false);
    };
    let header: Vec<&str> = lines[hdr_idx].split_whitespace().collect();
    let col = |names: &[&str]| header.iter().position(|h| names.contains(h));
    let (Some(pid_c), Some(cpu_c)) = (col(&["PID"]), col(&["%CPU", "CPU%"])) else {
        return (Vec::new(), false);
    };
    let user_c = col(&["USER"]);
    let mem_c = col(&["%MEM", "MEM%"]);
    let cmd_c = col(&["COMMAND", "COMM", "CMD"]).unwrap_or(header.len() - 1);
    let live = header.contains(&"S") || header.contains(&"TIME+");

    let mut procs = Vec::new();
    for line in &lines[hdr_idx + 1..] {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() <= cmd_c.max(cpu_c) {
            continue;
        }
        let Ok(pid) = cols[pid_c].parse::<u32>() else {
            continue;
        };
        procs.push(Process {
            pid,
            user: user_c.map(|c| cols[c].to_string()).unwrap_or_default(),
            cpu: num(cols[cpu_c]),
            mem: mem_c.map(|c| num(cols[c])),
            command: cols[cmd_c..].join(" "),
        });
        if procs.len() == 8 {
            break;
        }
    }
    (procs, live)
}

pub fn parse(out: &str) -> Result<Sample> {
    let mut s = Sample::default();
    let mut have_stat = false;
    let mut meminfo = std::collections::HashMap::new();

    for (name, lines) in sections(out) {
        match name {
            "stat" => {
                if let Some(line) = lines.iter().find(|l| l.starts_with("cpu ")) {
                    let v: Vec<u64> = line.split_whitespace().skip(1).map(num).collect();
                    // user nice system idle iowait irq softirq steal (guest is included in user)
                    s.cpu_total = v.iter().take(8).sum();
                    s.cpu_idle = v.get(3).copied().unwrap_or(0) + v.get(4).copied().unwrap_or(0);
                    have_stat = s.cpu_total > 0;
                }
            }
            "cpus" => s.cpu_count = lines.first().map(|l| num(l)).unwrap_or(0),
            "mem" => {
                for l in lines {
                    if let Some((k, v)) = l.split_once(':') {
                        let kb: u64 = num(v.trim().trim_end_matches("kB"));
                        meminfo.insert(k.trim().to_string(), kb);
                    }
                }
            }
            "net" => {
                for l in lines {
                    let Some((iface, rest)) = l.split_once(':') else {
                        continue;
                    };
                    let iface = iface.trim();
                    let v: Vec<u64> = rest.split_whitespace().map(num).collect();
                    if iface == "lo" || v.len() < 9 {
                        continue;
                    }
                    s.net.push(NetIf {
                        name: iface.to_string(),
                        rx_bytes: v[0],
                        tx_bytes: v[8],
                    });
                }
            }
            "load" => {
                let v: Vec<&str> = lines
                    .first()
                    .map(|l| l.split_whitespace().collect())
                    .unwrap_or_default();
                for i in 0..3 {
                    s.load[i] = v.get(i).map(|x| num(x)).unwrap_or(0.0);
                }
                if let Some((run, total)) = v.get(3).and_then(|t| t.split_once('/')) {
                    s.tasks_running = num(run);
                    s.tasks_total = num(total);
                }
            }
            "uptime" => {
                s.uptime_secs = lines
                    .first()
                    .and_then(|l| l.split_whitespace().next())
                    .map(num)
                    .unwrap_or(0.0)
            }
            "df" => {
                let mut seen = std::collections::HashSet::new();
                for l in lines.iter().skip(1) {
                    let c: Vec<&str> = l.split_whitespace().collect();
                    if c.len() < 6 {
                        continue;
                    }
                    let mount = c[5..].join(" ");
                    if !keep_disk(c[0], &mount) || !seen.insert(c[0].to_string()) {
                        continue;
                    }
                    s.disks.push(Disk {
                        filesystem: c[0].to_string(),
                        mount,
                        total_kb: num(c[1]),
                        used_kb: num(c[2]),
                        avail_kb: num(c[3]),
                    });
                }
            }
            "host" => {
                s.hostname = lines
                    .first()
                    .map(|l| l.trim().to_string())
                    .unwrap_or_default()
            }
            "kernel" => {
                s.kernel = lines
                    .first()
                    .map(|l| l.trim().to_string())
                    .unwrap_or_default()
            }
            "os" => {
                s.os = lines
                    .first()
                    .map(|l| l.trim().to_string())
                    .filter(|l| !l.is_empty())
            }
            "users" => s.users = lines.first().map(|l| num(l)).unwrap_or(0),
            "procs" => (s.processes, s.processes_live) = parse_processes(&lines),
            _ => {}
        }
    }

    if !have_stat {
        return Err(Error::msg(
            "Monitor hanya mendukung server Linux (butuh /proc/stat)",
        ));
    }
    let m = |k: &str| meminfo.get(k).copied().unwrap_or(0);
    s.mem_total_kb = m("MemTotal");
    // Kernels before 3.14 have no MemAvailable.
    s.mem_available_kb = meminfo
        .get("MemAvailable")
        .copied()
        .unwrap_or_else(|| m("MemFree") + m("Buffers") + m("Cached"));
    s.swap_total_kb = m("SwapTotal");
    s.swap_free_kb = m("SwapFree");
    Ok(s)
}

#[tauri::command]
pub async fn monitor_sample(state: State<'_, AppState>, id: String) -> Result<Sample> {
    let conn = state.conn(&id).await?;
    let res = run_exec(
        &conn,
        "sh -s",
        Some(SCRIPT.as_bytes()),
        Duration::from_secs(20),
    )
    .await?;
    parse(&res.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PROCPS: &str = "@@stat
cpu  4705 356 584 3699176 23060 0 277 0 0 0
@@cpus
4
@@mem
MemTotal:       16384000 kB
MemFree:         1000000 kB
MemAvailable:   12000000 kB
Buffers:          200000 kB
SwapTotal:       2097148 kB
SwapFree:        2000000 kB
@@net
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1000 10 0 0 0 0 0 0 1000 10 0 0 0 0 0 0
  eth0: 123456789 1000 0 0 0 0 0 0 987654 900 0 0 0 0 0 0
@@load
0.52 0.58 0.59 2/412 12345
@@uptime
350735.47 234388.90
@@df
Filesystem     1024-blocks      Used Available Capacity Mounted on
/dev/sda1         51474912  20395452  28441636      42% /
tmpfs              1635420         0   1635420       0% /dev/shm
/dev/sdb1        103081248  51540624  46281112      53% /mnt/data disk
/dev/loop3           56832     56832         0     100% /snap/core/1
@@host
web-01
@@kernel
Linux 6.8.0-45-generic
@@os
Ubuntu 24.04.1 LTS
@@users
2
@@procs
top - 10:00:00 up 4 days,  1:25,  2 users,  load average: 0.52, 0.58, 0.59
Tasks: 412 total,   2 running, 410 sleeping,   0 stopped,   0 zombie
%Cpu(s):  3.1 us,  1.0 sy,  0.0 ni, 95.9 id,  0.0 wa,  0.0 hi,  0.0 si,  0.0 st

    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND
   1234 www-data  20   0  812345  91234  12345 S  12.5   0.6   1:23.45 php-fpm: pool www
    987 root      20   0   12345   1234   1234 R   3.0   0.0   0:00.02 top
";

    #[test]
    fn parses_procps_linux() {
        let s = parse(PROCPS).unwrap();
        assert_eq!(s.cpu_count, 4);
        assert_eq!(s.cpu_total, 4705 + 356 + 584 + 3699176 + 23060 + 277);
        assert_eq!(s.cpu_idle, 3699176 + 23060);
        assert_eq!(s.mem_total_kb, 16384000);
        assert_eq!(s.mem_available_kb, 12000000);
        assert_eq!((s.swap_total_kb, s.swap_free_kb), (2097148, 2000000));
        assert_eq!(
            s.net,
            vec![NetIf {
                name: "eth0".into(),
                rx_bytes: 123456789,
                tx_bytes: 987654
            }]
        );
        assert_eq!(s.load, [0.52, 0.58, 0.59]);
        assert_eq!((s.tasks_running, s.tasks_total), (2, 412));
        assert_eq!(s.uptime_secs, 350735.47);
        let mounts: Vec<_> = s.disks.iter().map(|d| d.mount.as_str()).collect();
        assert_eq!(mounts, ["/", "/mnt/data disk"]);
        assert_eq!(s.disks[0].used_kb, 20395452);
        assert_eq!(
            (s.hostname.as_str(), s.kernel.as_str()),
            ("web-01", "Linux 6.8.0-45-generic")
        );
        assert_eq!(s.os.as_deref(), Some("Ubuntu 24.04.1 LTS"));
        assert_eq!(s.users, 2);
        assert!(s.processes_live);
        assert_eq!(s.processes.len(), 2);
        assert_eq!(s.processes[0].command, "php-fpm: pool www");
        assert_eq!(s.processes[0].cpu, 12.5);
        assert_eq!(s.processes[0].mem, Some(0.6));
        assert_eq!(s.processes[0].user, "www-data");
    }

    #[test]
    fn falls_back_to_ps_and_old_meminfo() {
        let out = "@@stat\ncpu 10 0 10 80 0 0 0 0\n@@mem\nMemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 50 kB\nCached: 150 kB\n\
@@procs\n  PID USER     %CPU %MEM COMMAND\n    1 root      0.1  0.2 init\n  812 mysql    25.0 30.1 mysqld\n";
        let s = parse(out).unwrap();
        assert_eq!(s.mem_available_kb, 300);
        assert!(!s.processes_live);
        assert_eq!(s.processes[1].command, "mysqld");
        assert_eq!(s.processes[1].cpu, 25.0);
    }

    #[test]
    fn rejects_non_linux() {
        let err = parse("@@stat\n@@cpus\n@@mem\n").unwrap_err();
        assert!(err.to_string().contains("Linux"));
    }
}
