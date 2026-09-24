//! Local port forwarding (`ssh -L`): listens on 127.0.0.1:<local_port> and
//! forwards each accepted connection through the SSH connection.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::State;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

use crate::error::Result;
use crate::ssh::AppState;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelInfo {
    id: String,
    local_port: u16,
    remote_host: String,
    remote_port: u16,
    connections: u64,
}

pub struct Tunnel {
    info: TunnelInfo,
    connections: Arc<AtomicU64>,
    task: JoinHandle<()>,
}

impl Tunnel {
    pub fn stop(self) {
        self.task.abort();
    }

    fn info(&self) -> TunnelInfo {
        TunnelInfo {
            connections: self.connections.load(Ordering::Relaxed),
            ..self.info.clone()
        }
    }
}

#[tauri::command]
pub async fn tunnel_start(
    state: State<'_, AppState>,
    id: String,
    local_port: u16,
    remote_host: String,
    remote_port: u16,
) -> Result<TunnelInfo> {
    let conn = state.conn(&id).await?;
    let listener = TcpListener::bind(("127.0.0.1", local_port)).await?;
    let local_port = listener.local_addr()?.port();
    let connections = Arc::new(AtomicU64::new(0));

    let task = {
        let conn = conn.clone();
        let connections = connections.clone();
        let remote_host = remote_host.clone();
        tokio::spawn(async move {
            while let Ok((mut socket, peer)) = listener.accept().await {
                let conn = conn.clone();
                let remote_host = remote_host.clone();
                connections.fetch_add(1, Ordering::Relaxed);
                tokio::spawn(async move {
                    let channel = conn
                        .handle
                        .channel_open_direct_tcpip(
                            remote_host,
                            remote_port as u32,
                            peer.ip().to_string(),
                            peer.port() as u32,
                        )
                        .await;
                    if let Ok(channel) = channel {
                        let mut stream = channel.into_stream();
                        let _ = tokio::io::copy_bidirectional(&mut socket, &mut stream).await;
                    }
                });
            }
        })
    };

    let info = TunnelInfo {
        id: uuid::Uuid::new_v4().to_string(),
        local_port,
        remote_host,
        remote_port,
        connections: 0,
    };
    conn.tunnels.lock().await.insert(
        info.id.clone(),
        Tunnel {
            info: info.clone(),
            connections,
            task,
        },
    );
    Ok(info)
}

#[tauri::command]
pub async fn tunnel_list(state: State<'_, AppState>, id: String) -> Result<Vec<TunnelInfo>> {
    let conn = state.conn(&id).await?;
    let tunnels = conn.tunnels.lock().await;
    Ok(tunnels.values().map(Tunnel::info).collect())
}

#[tauri::command]
pub async fn tunnel_stop(state: State<'_, AppState>, id: String, tunnel_id: String) -> Result<()> {
    let conn = state.conn(&id).await?;
    if let Some(t) = conn.tunnels.lock().await.remove(&tunnel_id) {
        t.stop();
    }
    Ok(())
}
