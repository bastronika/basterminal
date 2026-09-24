//! Unprivileged ICMP echo (ping), sweep and traceroute.
//!
//! Uses "ping sockets" (`SOCK_DGRAM` + `IPPROTO_ICMP`), which need no root:
//! Android allows them for every app, iOS/macOS always, desktop Linux when
//! `net.ipv4.ping_group_range` includes the user. Traceroute additionally
//! reads ICMP "time exceeded" errors from the Linux socket error queue
//! (`IP_RECVERR`), so it is available on Android and Linux only. IPv4 only.

use std::collections::HashMap;
use std::io::{self, Read};
use std::net::{Ipv4Addr, SocketAddrV4};
use std::time::{Duration, Instant};

use socket2::{Domain, Protocol, SockAddr, Socket, Type};

const ECHO_REQUEST: u8 = 8;
const ECHO_REPLY: u8 = 0;
#[cfg(any(target_os = "linux", target_os = "android"))]
pub const DEST_UNREACHABLE: u8 = 3;

pub fn open() -> io::Result<Socket> {
    Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::ICMPV4))
}

/// Human explanation when ping sockets are not permitted.
pub fn unavailable_reason(e: &io::Error) -> String {
    format!("ICMP tidak diizinkan di perangkat ini ({e})")
}

fn checksum(data: &[u8]) -> u16 {
    let mut sum: u32 = data
        .chunks(2)
        .map(|c| u32::from(u16::from_be_bytes([c[0], *c.get(1).unwrap_or(&0)])))
        .sum();
    while sum >> 16 != 0 {
        sum = (sum & 0xffff) + (sum >> 16);
    }
    !(sum as u16)
}

/// Echo request with a 32-byte payload. The kernel may rewrite the
/// identifier (Linux uses the socket's "port"), so replies are matched by
/// sequence number.
pub fn echo_request(ident: u16, seq: u16) -> Vec<u8> {
    let mut pkt = vec![ECHO_REQUEST, 0, 0, 0];
    pkt.extend_from_slice(&ident.to_be_bytes());
    pkt.extend_from_slice(&seq.to_be_bytes());
    pkt.extend(b"basterminal-ping-0123456789abcde");
    let sum = checksum(&pkt);
    pkt[2..4].copy_from_slice(&sum.to_be_bytes());
    pkt
}

#[derive(Debug, PartialEq)]
pub struct IcmpHeader {
    pub kind: u8,
    pub code: u8,
    pub seq: u16,
}

/// Parses an ICMP message; macOS/iOS prepend the IPv4 header, Linux doesn't.
pub fn parse_icmp(buf: &[u8]) -> Option<IcmpHeader> {
    let buf = if buf.len() >= 28 && buf[0] >> 4 == 4 {
        &buf[usize::from(buf[0] & 0x0f) * 4..]
    } else {
        buf
    };
    (buf.len() >= 8).then(|| IcmpHeader {
        kind: buf[0],
        code: buf[1],
        seq: u16::from_be_bytes([buf[6], buf[7]]),
    })
}

fn recv(sock: &Socket, buf: &mut [u8]) -> io::Result<usize> {
    (&*sock).read(buf)
}

/// Sends one echo and waits for the matching reply. Returns the RTT, or
/// None on timeout.
pub fn ping_once(sock: &Socket, seq: u16, timeout: Duration) -> io::Result<Option<Duration>> {
    // Discard stale replies from earlier (timed-out) probes.
    sock.set_nonblocking(true)?;
    let mut buf = [0u8; 1500];
    while recv(sock, &mut buf).is_ok() {}
    sock.set_nonblocking(false)?;

    let start = Instant::now();
    sock.send(&echo_request(0xba57, seq))?;
    loop {
        let left = timeout.saturating_sub(start.elapsed());
        if left.is_zero() {
            return Ok(None);
        }
        sock.set_read_timeout(Some(left))?;
        match recv(sock, &mut buf) {
            Ok(n) => {
                if let Some(h) = parse_icmp(&buf[..n]) {
                    if h.kind == ECHO_REPLY && h.seq == seq {
                        return Ok(Some(start.elapsed()));
                    }
                }
            }
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) =>
            {
                return Ok(None)
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
}

pub fn connect(sock: &Socket, ip: Ipv4Addr) -> io::Result<()> {
    sock.connect(&SockAddr::from(SocketAddrV4::new(ip, 0)))
}

/// Pings every address at once from one socket and returns those that
/// answered within `wait`, with their RTT.
pub fn sweep(targets: &[Ipv4Addr], wait: Duration) -> io::Result<HashMap<Ipv4Addr, Duration>> {
    let sock = open()?;
    let mut sent = HashMap::new();
    for (i, ip) in targets.iter().enumerate() {
        let seq = i as u16;
        let to = SockAddr::from(SocketAddrV4::new(*ip, 0));
        // Unreachable neighbours can fail individually; keep sweeping.
        if sock.send_to(&echo_request(0xba58, seq), &to).is_ok() {
            sent.insert(seq, (*ip, Instant::now()));
        }
        if i % 64 == 63 {
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    let mut alive = HashMap::new();
    let deadline = Instant::now() + wait;
    let mut buf = [std::mem::MaybeUninit::<u8>::uninit(); 1500];
    while let Some(left) = deadline
        .checked_duration_since(Instant::now())
        .filter(|d| !d.is_zero())
    {
        sock.set_read_timeout(Some(left))?;
        match sock.recv_from(&mut buf) {
            Ok((n, from)) => {
                // SAFETY: recv_from initialised the first n bytes.
                let data: Vec<u8> = buf[..n]
                    .iter()
                    .map(|b| unsafe { b.assume_init() })
                    .collect();
                let (Some(h), Some(from)) = (parse_icmp(&data), from.as_socket_ipv4()) else {
                    continue;
                };
                if h.kind != ECHO_REPLY {
                    continue;
                }
                if let Some((ip, t0)) = sent.get(&h.seq) {
                    if *ip == *from.ip() {
                        alive.entry(*ip).or_insert_with(|| t0.elapsed());
                    }
                }
            }
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) =>
            {
                break
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(alive)
}

#[cfg(any(target_os = "linux", target_os = "android"))]
#[derive(Debug)]
pub enum ProbeResult {
    /// A router on the path answered "time exceeded" (or unreachable).
    Hop {
        from: Ipv4Addr,
        rtt: Duration,
        kind: u8,
        code: u8,
    },
    /// The destination answered the echo.
    Reached {
        rtt: Duration,
    },
    Timeout,
}

/// One traceroute probe with the given TTL, via the Linux error queue.
#[cfg(any(target_os = "linux", target_os = "android"))]
pub fn trace_probe(
    sock: &Socket,
    ttl: u32,
    seq: u16,
    timeout: Duration,
) -> io::Result<ProbeResult> {
    use std::os::fd::AsRawFd;

    let fd = sock.as_raw_fd();
    drain_errqueue(fd);
    // A pending socket error from an earlier probe would fail this send.
    let _ = sock.take_error();
    sock.set_ttl_v4(ttl)?;
    let start = Instant::now();
    if let Err(e) = sock.send(&echo_request(0xba59, seq)) {
        // EHOSTUNREACH etc. arrive as send errors when the error was already queued.
        if e.raw_os_error().is_none() {
            return Err(e);
        }
    }
    let mut buf = [0u8; 1500];
    loop {
        let left = timeout.saturating_sub(start.elapsed());
        if left.is_zero() {
            return Ok(ProbeResult::Timeout);
        }
        let mut pfd = libc::pollfd {
            fd,
            events: libc::POLLIN | libc::POLLERR,
            revents: 0,
        };
        let ms = left.as_millis().clamp(1, i32::MAX as u128) as i32;
        // SAFETY: pfd is a valid pollfd for the duration of the call.
        let rc = unsafe { libc::poll(&mut pfd, 1, ms) };
        if rc < 0 {
            let e = io::Error::last_os_error();
            if e.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(e);
        }
        if rc == 0 {
            return Ok(ProbeResult::Timeout);
        }
        if pfd.revents & libc::POLLERR != 0 {
            if let Some(err) = read_errqueue(fd)? {
                let ours = err.seq == Some(seq) || err.seq.is_none();
                if ours && !err.from.is_unspecified() {
                    return Ok(ProbeResult::Hop {
                        from: err.from,
                        rtt: start.elapsed(),
                        kind: err.kind,
                        code: err.code,
                    });
                }
            }
            continue;
        }
        if pfd.revents & libc::POLLIN != 0 {
            sock.set_nonblocking(true)?;
            let r = recv(sock, &mut buf);
            sock.set_nonblocking(false)?;
            if let Ok(n) = r {
                if let Some(h) = parse_icmp(&buf[..n]) {
                    if h.kind == ECHO_REPLY && h.seq == seq {
                        return Ok(ProbeResult::Reached {
                            rtt: start.elapsed(),
                        });
                    }
                }
            }
        }
    }
}

#[cfg(any(target_os = "linux", target_os = "android"))]
pub fn enable_recverr(sock: &Socket) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    let one: libc::c_int = 1;
    // SAFETY: valid fd and option value pointer/length.
    let rc = unsafe {
        libc::setsockopt(
            sock.as_raw_fd(),
            libc::IPPROTO_IP,
            libc::IP_RECVERR,
            &one as *const _ as *const libc::c_void,
            std::mem::size_of::<libc::c_int>() as libc::socklen_t,
        )
    };
    if rc == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn drain_errqueue(fd: std::os::fd::RawFd) {
    while let Ok(Some(_)) = read_errqueue(fd) {}
}

/// An ICMP error the kernel queued for one of our probes.
#[cfg(any(target_os = "linux", target_os = "android"))]
struct QueuedError {
    /// The router (or host) that sent the error; unspecified for non-ICMP errors.
    from: Ipv4Addr,
    kind: u8,
    code: u8,
    /// Sequence number of our original probe, when the kernel returned its header.
    seq: Option<u16>,
}

/// Reads one queued error from the socket error queue.
#[cfg(any(target_os = "linux", target_os = "android"))]
fn read_errqueue(fd: std::os::fd::RawFd) -> io::Result<Option<QueuedError>> {
    let mut data = [0u8; 576];
    let mut control = [0u8; 512];
    let mut iov = libc::iovec {
        iov_base: data.as_mut_ptr() as *mut libc::c_void,
        iov_len: data.len(),
    };
    // SAFETY: zeroed msghdr is a valid "empty" value; pointers set below
    // stay valid for the recvmsg call.
    let mut msg: libc::msghdr = unsafe { std::mem::zeroed() };
    msg.msg_iov = &mut iov;
    msg.msg_iovlen = 1;
    msg.msg_control = control.as_mut_ptr() as *mut libc::c_void;
    msg.msg_controllen = control.len() as _;

    // SAFETY: msg describes valid buffers.
    let n = unsafe { libc::recvmsg(fd, &mut msg, libc::MSG_ERRQUEUE | libc::MSG_DONTWAIT) };
    if n < 0 {
        let e = io::Error::last_os_error();
        return if e.kind() == io::ErrorKind::WouldBlock {
            Ok(None)
        } else {
            Err(e)
        };
    }
    let probe_seq = parse_icmp(&data[..n as usize]).map(|h| h.seq);

    // SAFETY: walking the control buffer with the libc CMSG helpers.
    unsafe {
        let mut cmsg = libc::CMSG_FIRSTHDR(&msg);
        while !cmsg.is_null() {
            if (*cmsg).cmsg_level == libc::IPPROTO_IP && (*cmsg).cmsg_type == libc::IP_RECVERR {
                let ee = libc::CMSG_DATA(cmsg) as *const libc::sock_extended_err;
                if (*ee).ee_origin == libc::SO_EE_ORIGIN_ICMP {
                    // SO_EE_OFFENDER: the sockaddr right after the struct.
                    let sa = ee.add(1) as *const libc::sockaddr_in;
                    let from = Ipv4Addr::from(u32::from_be((*sa).sin_addr.s_addr));
                    return Ok(Some(QueuedError {
                        from,
                        kind: (*ee).ee_type,
                        code: (*ee).ee_code,
                        seq: probe_seq,
                    }));
                }
            }
            cmsg = libc::CMSG_NXTHDR(&msg, cmsg);
        }
    }
    // A queued error that is not ICMP (e.g. local): consumed, no router address.
    Ok(Some(QueuedError {
        from: Ipv4Addr::UNSPECIFIED,
        kind: 0,
        code: 0,
        seq: None,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn echo_request_has_valid_checksum() {
        let pkt = echo_request(0x1234, 7);
        assert_eq!(pkt[0], ECHO_REQUEST);
        assert_eq!(
            checksum(&pkt),
            0,
            "checksum over a packet with its checksum is zero"
        );
        assert_eq!(parse_icmp(&pkt).unwrap().seq, 7);
    }

    #[test]
    fn parse_strips_ipv4_header() {
        let mut ip = vec![
            0x45, 0, 0, 48, 0, 0, 0, 0, 64, 1, 0, 0, 10, 0, 0, 1, 10, 0, 0, 2,
        ];
        let mut reply = echo_request(1, 42);
        reply[0] = ECHO_REPLY;
        ip.extend(reply);
        let h = parse_icmp(&ip).unwrap();
        assert_eq!((h.kind, h.seq), (ECHO_REPLY, 42));
    }
}
