mod error;
mod known_hosts;
mod nettools;
mod sftp;
mod ssh;
mod tunnel;

use std::sync::Arc;

use tauri::Manager;

use crate::error::Result;
use crate::known_hosts::KnownHosts;
use crate::ssh::AppState;

/// Saved session profiles are stored as an opaque JSON document owned by the
/// frontend, inside the app's private data directory.
#[tauri::command]
fn profiles_load(app: tauri::AppHandle) -> Result<serde_json::Value> {
    let path = app.path().app_data_dir()?.join("profiles.json");
    match std::fs::read_to_string(path) {
        Ok(s) => Ok(serde_json::from_str(&s)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::json!([])),
        Err(e) => Err(e.into()),
    }
}

#[tauri::command]
fn profiles_save(app: tauri::AppHandle, profiles: serde_json::Value) -> Result<()> {
    let dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&dir)?;
    std::fs::write(
        dir.join("profiles.json"),
        serde_json::to_string_pretty(&profiles)?,
    )?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .setup(|app| {
            let path = app.path().app_data_dir()?.join("known_hosts.json");
            let state = app.state::<AppState>();
            let _ = state.known_hosts.set(Arc::new(KnownHosts::load(path)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            profiles_load,
            profiles_save,
            ssh::ssh_connect,
            ssh::ssh_write,
            ssh::ssh_resize,
            ssh::ssh_exec,
            ssh::ssh_disconnect,
            ssh::hostkey_decide,
            ssh::known_hosts_list,
            ssh::known_hosts_remove,
            sftp::sftp_list,
            sftp::sftp_mkdir,
            sftp::sftp_remove,
            sftp::sftp_rename,
            sftp::sftp_chmod,
            sftp::sftp_read,
            sftp::sftp_write,
            sftp::sftp_download,
            tunnel::tunnel_start,
            tunnel::tunnel_list,
            tunnel::tunnel_stop,
            nettools::net_tcp_ping,
            nettools::net_port_scan,
            nettools::net_dns_lookup,
        ])
        .run(tauri::generate_context!())
        .expect("error while running basterminal");
}
