//! SFTP file browser operations over an existing SSH connection.

use std::path::PathBuf;
use std::sync::Arc;

use base64::Engine;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tokio::io::AsyncWriteExt;

use crate::error::{Error, Result};
use crate::ssh::{AppState, Conn};

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;
/// Files above this size are refused by the in-app editor / base64 transfer.
const MAX_INLINE_BYTES: u64 = 64 * 1024 * 1024;

async fn sftp(conn: &Conn) -> Result<Arc<SftpSession>> {
    let mut slot = conn.sftp.lock().await;
    if let Some(s) = slot.as_ref() {
        return Ok(s.clone());
    }
    let channel = conn.handle.channel_open_session().await?;
    channel.request_subsystem(true, "sftp").await?;
    let session = Arc::new(SftpSession::new(channel.into_stream()).await?);
    *slot = Some(session.clone());
    Ok(session)
}

async fn session(state: &AppState, id: &str) -> Result<Arc<SftpSession>> {
    let conn = state.conn(id).await?;
    sftp(&conn).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    name: String,
    path: String,
    is_dir: bool,
    is_link: bool,
    size: u64,
    mtime: Option<u32>,
    permissions: Option<u32>,
}

#[derive(Serialize)]
pub struct Listing {
    path: String,
    entries: Vec<Entry>,
}

fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

#[tauri::command]
pub async fn sftp_list(
    state: State<'_, AppState>,
    id: String,
    path: Option<String>,
) -> Result<Listing> {
    let sftp = session(&state, &id).await?;
    let path = sftp
        .canonicalize(path.unwrap_or_else(|| ".".into()))
        .await?;
    let mut entries = Vec::new();
    for e in sftp.read_dir(path.clone()).await? {
        let name = e.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let meta = e.metadata();
        let full = join(&path, &name);
        let is_link = e.file_type().is_symlink();
        // Follow symlinks so linked directories are browsable.
        let is_dir = if is_link {
            sftp.metadata(full.clone())
                .await
                .map(|m| m.is_dir())
                .unwrap_or(false)
        } else {
            e.file_type().is_dir()
        };
        entries.push(Entry {
            name,
            path: full,
            is_dir,
            is_link,
            size: meta.size.unwrap_or(0),
            mtime: meta.mtime,
            permissions: meta.permissions,
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(Listing { path, entries })
}

#[tauri::command]
pub async fn sftp_mkdir(state: State<'_, AppState>, id: String, path: String) -> Result<()> {
    session(&state, &id).await?.create_dir(path).await?;
    Ok(())
}

#[tauri::command]
pub async fn sftp_remove(
    state: State<'_, AppState>,
    id: String,
    path: String,
    is_dir: bool,
) -> Result<()> {
    let sftp = session(&state, &id).await?;
    if is_dir {
        sftp.remove_dir(path).await?;
    } else {
        sftp.remove_file(path).await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn sftp_rename(
    state: State<'_, AppState>,
    id: String,
    from: String,
    to: String,
) -> Result<()> {
    session(&state, &id).await?.rename(from, to).await?;
    Ok(())
}

#[tauri::command]
pub async fn sftp_chmod(
    state: State<'_, AppState>,
    id: String,
    path: String,
    mode: u32,
) -> Result<()> {
    let sftp = session(&state, &id).await?;
    let mut meta = sftp.metadata(path.clone()).await?;
    let type_bits = meta.permissions.unwrap_or(0) & !0o7777;
    meta.permissions = Some(type_bits | (mode & 0o7777));
    sftp.set_metadata(path, meta).await?;
    Ok(())
}

async fn read_checked(sftp: &SftpSession, path: &str) -> Result<Vec<u8>> {
    let size = sftp.metadata(path.to_string()).await?.size.unwrap_or(0);
    if size > MAX_INLINE_BYTES {
        return Err(Error::msg(format!("File terlalu besar ({size} byte)")));
    }
    Ok(sftp.read(path.to_string()).await?)
}

/// Reads a remote file, returned base64-encoded.
#[tauri::command]
pub async fn sftp_read(state: State<'_, AppState>, id: String, path: String) -> Result<String> {
    let sftp = session(&state, &id).await?;
    Ok(B64.encode(read_checked(&sftp, &path).await?))
}

/// Writes a remote file from base64 data, creating it or replacing its whole
/// content. (`SftpSession::write` opens without TRUNCATE, which would leave
/// stale bytes behind when the new content is shorter.) Existing owner and
/// permissions are kept because the file is truncated in place.
#[tauri::command]
pub async fn sftp_write(
    state: State<'_, AppState>,
    id: String,
    path: String,
    data: String,
) -> Result<()> {
    let bytes = B64.decode(data).map_err(|e| Error::msg(e.to_string()))?;
    let sftp = session(&state, &id).await?;
    let flags = OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE;
    let mut file = sftp.open_with_flags(path, flags).await?;
    file.write_all(&bytes).await?;
    // flush waits for every write acknowledgement, so errors (disk full,
    // quota) surface here instead of being lost on close.
    file.flush().await?;
    file.shutdown().await?;
    Ok(())
}

/// Creates an empty file; fails if it already exists.
#[tauri::command]
pub async fn sftp_create(state: State<'_, AppState>, id: String, path: String) -> Result<()> {
    let sftp = session(&state, &id).await?;
    let flags = OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE;
    let mut file = sftp
        .open_with_flags(path, flags)
        .await
        .map_err(|e| Error::msg(format!("Tidak bisa membuat file: {e}")))?;
    file.shutdown().await?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stat {
    size: u64,
    mtime: Option<u32>,
    permissions: Option<u32>,
    is_dir: bool,
}

#[tauri::command]
pub async fn sftp_stat(state: State<'_, AppState>, id: String, path: String) -> Result<Stat> {
    let meta = session(&state, &id).await?.metadata(path).await?;
    Ok(Stat {
        size: meta.size.unwrap_or(0),
        mtime: meta.mtime,
        permissions: meta.permissions,
        is_dir: meta.is_dir(),
    })
}

/// Candidate folders for downloads, most user-visible first. On Android the
/// public Download folder may be read-only for the app, hence the fallbacks.
fn download_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let p = app.path();
    [
        p.download_dir(),
        p.document_dir(),
        p.app_data_dir().map(|d| d.join("downloads")),
    ]
    .into_iter()
    .flatten()
    .map(|d| d.join("basterminal"))
    .collect()
}

/// Downloads a remote file into Download/basterminal (or the first writable
/// fallback folder) and returns the local path.
#[tauri::command]
pub async fn sftp_download(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    path: String,
) -> Result<String> {
    let sftp = session(&state, &id).await?;
    let data = read_checked(&sftp, &path).await?;
    let name = path
        .rsplit('/')
        .next()
        .filter(|n| !n.is_empty())
        .unwrap_or("download");
    let mut last_err = Error::msg("Tidak ada folder download yang bisa ditulis");
    for dir in download_dirs(&app) {
        let target = dir.join(name);
        let res = async {
            tokio::fs::create_dir_all(&dir).await?;
            tokio::fs::write(&target, &data).await
        };
        match res.await {
            Ok(()) => return Ok(target.to_string_lossy().into_owned()),
            Err(e) => last_err = e.into(),
        }
    }
    Err(last_err)
}
