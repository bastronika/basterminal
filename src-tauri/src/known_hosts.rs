//! Trust-on-first-use host key store, persisted as JSON in the app data dir.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::error::Result;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct HostKey {
    pub algorithm: String,
    pub fingerprint: String,
}

pub struct KnownHosts {
    path: PathBuf,
    entries: Mutex<HashMap<String, HostKey>>,
}

impl KnownHosts {
    pub fn load(path: PathBuf) -> Self {
        let entries = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Self {
            path,
            entries: Mutex::new(entries),
        }
    }

    pub fn get(&self, host: &str) -> Option<HostKey> {
        self.entries.lock().unwrap().get(host).cloned()
    }

    pub fn set(&self, host: &str, key: HostKey) -> Result<()> {
        let mut entries = self.entries.lock().unwrap();
        entries.insert(host.to_string(), key);
        self.save(&entries)
    }

    pub fn remove(&self, host: &str) -> Result<()> {
        let mut entries = self.entries.lock().unwrap();
        entries.remove(host);
        self.save(&entries)
    }

    pub fn all(&self) -> HashMap<String, HostKey> {
        self.entries.lock().unwrap().clone()
    }

    fn save(&self, entries: &HashMap<String, HostKey>) -> Result<()> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(&self.path, serde_json::to_string_pretty(entries)?)?;
        Ok(())
    }
}
