use std::path::PathBuf;

use anyhow::{anyhow, Result};

const HOME_SUBDIR: &str = "monica";

/// Resolve Monica's base directory: `$MONICA_HOME` when set, otherwise `$HOME/monica`.
pub fn base_dir() -> Result<PathBuf> {
    if let Some(home) = std::env::var_os("MONICA_HOME") {
        return Ok(PathBuf::from(home));
    }
    let home =
        std::env::var_os("HOME").ok_or_else(|| anyhow!("neither MONICA_HOME nor HOME is set"))?;
    Ok(PathBuf::from(home).join(HOME_SUBDIR))
}

pub fn db_path() -> Result<PathBuf> {
    Ok(base_dir()?.join("db").join("monica.db"))
}

pub fn runs_dir() -> Result<PathBuf> {
    Ok(base_dir()?.join("runs"))
}
