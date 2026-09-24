use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Msg(String),
    #[error("SSH: {0}")]
    Ssh(#[from] russh::Error),
    #[error("SFTP: {0}")]
    Sftp(#[from] russh_sftp::client::error::Error),
    #[error("Key: {0}")]
    Key(#[from] russh::keys::Error),
    #[error("IO: {0}")]
    Io(#[from] std::io::Error),
    #[error("Tauri: {0}")]
    Tauri(#[from] tauri::Error),
    #[error("JSON: {0}")]
    Json(#[from] serde_json::Error),
}

impl Error {
    pub fn msg(s: impl Into<String>) -> Self {
        Error::Msg(s.into())
    }
}

// Commands return errors to the frontend as plain strings.
impl Serialize for Error {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;
