//! SSH connections: authentication, interactive shell, remote exec and
//! host key verification. Each connection is identified by a UUID string
//! and can additionally carry an SFTP session and port-forward tunnels.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use russh::client::{self, KeyboardInteractiveAuthResponse, Msg};
use russh::keys::{decode_secret_key, HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::{ChannelMsg, ChannelWriteHalf, Disconnect};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{oneshot, Mutex};
use tokio::task::JoinHandle;

use crate::error::{Error, Result};
use crate::known_hosts::{HostKey, KnownHosts};

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

pub struct Conn {
    pub handle: client::Handle<Client>,
    pub shell: Mutex<Option<ChannelWriteHalf<Msg>>>,
    pub sftp: Mutex<Option<Arc<russh_sftp::client::SftpSession>>>,
    pub tunnels: Mutex<HashMap<String, crate::tunnel::Tunnel>>,
    reader: Mutex<Option<JoinHandle<()>>>,
}

#[derive(Default)]
pub struct AppState {
    pub conns: Mutex<HashMap<String, Arc<Conn>>>,
    pub hostkey_pending: Mutex<HashMap<String, oneshot::Sender<bool>>>,
    pub known_hosts: std::sync::OnceLock<Arc<KnownHosts>>,
}

impl AppState {
    pub async fn conn(&self, id: &str) -> Result<Arc<Conn>> {
        self.conns
            .lock()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| Error::msg("Koneksi tidak ditemukan / sudah terputus"))
    }

    pub fn known_hosts(&self) -> Arc<KnownHosts> {
        self.known_hosts
            .get()
            .expect("known_hosts initialised in setup")
            .clone()
    }
}

/// russh event handler. Only host key verification needs custom logic: an
/// unknown or changed key is sent to the UI, which asks the user to decide.
pub struct Client {
    app: AppHandle,
    request_id: String,
    host_key_id: String,
    known: Arc<KnownHosts>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostKeyPrompt {
    request_id: String,
    host: String,
    algorithm: String,
    fingerprint: String,
    /// Previously trusted fingerprint when the key changed (possible MITM).
    previous: Option<String>,
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> std::result::Result<bool, Self::Error> {
        let key_data = match server_public_key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.key_data().clone(),
            PublicKeyOrCertificate::Certificate(cert) => cert.public_key().clone(),
        };
        let presented = HostKey {
            algorithm: key_data.algorithm().to_string(),
            fingerprint: key_data.fingerprint(HashAlg::Sha256).to_string(),
        };
        let previous = self.known.get(&self.host_key_id);
        if previous.as_ref() == Some(&presented) {
            return Ok(true);
        }

        let (tx, rx) = oneshot::channel();
        {
            use tauri::Manager;
            let state = self.app.state::<AppState>();
            state
                .hostkey_pending
                .lock()
                .await
                .insert(self.request_id.clone(), tx);
        }
        let _ = self.app.emit(
            "hostkey-prompt",
            HostKeyPrompt {
                request_id: self.request_id.clone(),
                host: self.host_key_id.clone(),
                algorithm: presented.algorithm.clone(),
                fingerprint: presented.fingerprint.clone(),
                previous: previous.map(|p| p.fingerprint),
            },
        );
        let accepted = tokio::time::timeout(Duration::from_secs(300), rx)
            .await
            .ok()
            .and_then(|r| r.ok())
            .unwrap_or(false);
        if accepted {
            let _ = self.known.set(&self.host_key_id, presented);
        }
        Ok(accepted)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectRequest {
    /// Chosen by the frontend so it can match `hostkey-prompt` events.
    pub request_id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub passphrase: Option<String>,
    pub cols: u32,
    pub rows: u32,
    pub keepalive_secs: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TermEvent {
    /// Base64-encoded terminal output.
    Data {
        data: String,
    },
    Closed {
        reason: String,
    },
}

#[tauri::command]
pub async fn hostkey_decide(
    state: State<'_, AppState>,
    request_id: String,
    accept: bool,
) -> Result<()> {
    if let Some(tx) = state.hostkey_pending.lock().await.remove(&request_id) {
        let _ = tx.send(accept);
    }
    Ok(())
}

#[tauri::command]
pub fn known_hosts_list(state: State<'_, AppState>) -> HashMap<String, HostKey> {
    state.known_hosts().all()
}

#[tauri::command]
pub fn known_hosts_remove(state: State<'_, AppState>, host: String) -> Result<()> {
    state.known_hosts().remove(&host)
}

async fn authenticate(handle: &mut client::Handle<Client>, req: &ConnectRequest) -> Result<()> {
    let user = req.username.clone();

    if let Some(pem) = req.private_key.as_deref().filter(|k| !k.trim().is_empty()) {
        let key = decode_secret_key(pem, req.passphrase.as_deref().filter(|p| !p.is_empty()))?;
        let hash = handle.best_supported_rsa_hash().await?.flatten();
        let res = handle
            .authenticate_publickey(
                user.clone(),
                PrivateKeyWithHashAlg::new(Arc::new(key), hash),
            )
            .await?;
        if res.success() {
            return Ok(());
        }
        if req.password.is_none() {
            return Err(Error::msg("Autentikasi private key ditolak server"));
        }
    }

    let Some(password) = req.password.clone() else {
        return Err(Error::msg("Password atau private key diperlukan"));
    };

    if handle
        .authenticate_password(user.clone(), password.clone())
        .await?
        .success()
    {
        return Ok(());
    }

    // Many servers only enable keyboard-interactive; answer every prompt with the password.
    let mut resp = handle
        .authenticate_keyboard_interactive_start(user, None)
        .await?;
    for _ in 0..5 {
        match resp {
            KeyboardInteractiveAuthResponse::Success => return Ok(()),
            KeyboardInteractiveAuthResponse::Failure { .. } => break,
            KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                let answers = prompts.iter().map(|_| password.clone()).collect();
                resp = handle
                    .authenticate_keyboard_interactive_respond(answers)
                    .await?;
            }
        }
    }
    Err(Error::msg("Autentikasi gagal: username/password salah"))
}

/// Connects, authenticates and opens an interactive PTY shell. Terminal
/// output is streamed through `on_event`. Returns the connection id.
#[tauri::command]
pub async fn ssh_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    req: ConnectRequest,
    on_event: Channel<TermEvent>,
) -> Result<String> {
    let config = Arc::new(client::Config {
        keepalive_interval: Some(Duration::from_secs(req.keepalive_secs.unwrap_or(30).max(5))),
        keepalive_max: 4,
        inactivity_timeout: None,
        ..Default::default()
    });
    let handler = Client {
        app: app.clone(),
        request_id: req.request_id.clone(),
        host_key_id: format!("[{}]:{}", req.host, req.port),
        known: state.known_hosts(),
    };

    let connect = client::connect(config, (req.host.as_str(), req.port), handler);
    // Generous timeout: it includes the time the user spends on the host key prompt.
    let mut handle = tokio::time::timeout(Duration::from_secs(330), connect)
        .await
        .map_err(|_| Error::msg("Timeout saat menghubungi server"))?
        .map_err(|e| match e {
            russh::Error::UnknownKey => Error::msg("Host key ditolak"),
            e => Error::Ssh(e),
        })?;
    state.hostkey_pending.lock().await.remove(&req.request_id);

    authenticate(&mut handle, &req).await?;

    let channel = handle.channel_open_session().await?;
    channel
        .request_pty(false, "xterm-256color", req.cols, req.rows, 0, 0, &[])
        .await?;
    channel.request_shell(false).await?;
    let (mut read, write) = channel.split();

    let id = uuid::Uuid::new_v4().to_string();
    let reader = tokio::spawn(async move {
        let mut reason = "Sesi ditutup".to_string();
        while let Some(msg) = read.wait().await {
            match msg {
                ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                    let _ = on_event.send(TermEvent::Data {
                        data: B64.encode(&data),
                    });
                }
                ChannelMsg::ExitStatus { exit_status } => {
                    reason = format!("Proses selesai (exit {exit_status})");
                }
                ChannelMsg::Eof | ChannelMsg::Close => break,
                _ => {}
            }
        }
        let _ = on_event.send(TermEvent::Closed { reason });
    });

    let conn = Arc::new(Conn {
        handle,
        shell: Mutex::new(Some(write)),
        sftp: Mutex::new(None),
        tunnels: Mutex::new(HashMap::new()),
        reader: Mutex::new(Some(reader)),
    });
    state.conns.lock().await.insert(id.clone(), conn);
    Ok(id)
}

#[tauri::command]
pub async fn ssh_write(state: State<'_, AppState>, id: String, data: String) -> Result<()> {
    let conn = state.conn(&id).await?;
    let shell = conn.shell.lock().await;
    let shell = shell
        .as_ref()
        .ok_or_else(|| Error::msg("Shell tidak aktif"))?;
    shell.data_bytes(data.into_bytes()).await?;
    Ok(())
}

#[tauri::command]
pub async fn ssh_resize(
    state: State<'_, AppState>,
    id: String,
    cols: u32,
    rows: u32,
) -> Result<()> {
    let conn = state.conn(&id).await?;
    if let Some(shell) = conn.shell.lock().await.as_ref() {
        shell.window_change(cols, rows, 0, 0).await?;
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<u32>,
}

/// Runs `command` on a separate channel, optionally feeding `stdin`, and
/// collects its output.
pub async fn run_exec(
    conn: &Conn,
    command: &str,
    stdin: Option<&[u8]>,
    timeout: Duration,
) -> Result<ExecResult> {
    let mut channel = conn.handle.channel_open_session().await?;
    channel.exec(true, command).await?;
    if let Some(input) = stdin {
        channel.data(input).await?;
        channel.eof().await?;
    }
    let (mut stdout, mut stderr, mut exit_code) = (Vec::new(), Vec::new(), None);
    let run = async {
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
                ChannelMsg::ExtendedData { data, .. } => stderr.extend_from_slice(&data),
                ChannelMsg::ExitStatus { exit_status } => exit_code = Some(exit_status),
                ChannelMsg::Close => break,
                _ => {}
            }
        }
    };
    tokio::time::timeout(timeout, run)
        .await
        .map_err(|_| Error::msg("Timeout menjalankan perintah"))?;
    Ok(ExecResult {
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        exit_code,
    })
}

/// Runs a single command on a separate channel.
#[tauri::command]
pub async fn ssh_exec(
    state: State<'_, AppState>,
    id: String,
    command: String,
) -> Result<ExecResult> {
    let conn = state.conn(&id).await?;
    run_exec(&conn, &command, None, Duration::from_secs(30)).await
}

#[tauri::command]
pub async fn ssh_disconnect(state: State<'_, AppState>, id: String) -> Result<()> {
    let Some(conn) = state.conns.lock().await.remove(&id) else {
        return Ok(());
    };
    for (_, t) in conn.tunnels.lock().await.drain() {
        t.stop();
    }
    if let Some(sftp) = conn.sftp.lock().await.take() {
        let _ = sftp.close().await;
    }
    if let Some(shell) = conn.shell.lock().await.take() {
        let _ = shell.close().await;
    }
    let _ = conn
        .handle
        .disconnect(Disconnect::ByApplication, "bye", "en")
        .await;
    if let Some(reader) = conn.reader.lock().await.take() {
        // Give the reader a moment to deliver the Closed event, then stop it.
        let abort = reader.abort_handle();
        if tokio::time::timeout(Duration::from_secs(2), reader)
            .await
            .is_err()
        {
            abort.abort();
        }
    }
    Ok(())
}
