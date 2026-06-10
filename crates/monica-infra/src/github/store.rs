use std::fs;

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};

use crate::filesystem::paths;

const KEYCHAIN_SERVICE: &str = "monica.github";
const KEYCHAIN_ACCOUNT: &str = "github.com";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredGithubToken {
    pub access_token: String,
    pub access_expires_at: Option<i64>,
    pub refresh_token: Option<String>,
    pub refresh_expires_at: Option<i64>,
    pub login: Option<String>,
    pub saved_at: i64,
}

impl StoredGithubToken {
    pub fn access_token_valid_at(&self, now: i64, skew_seconds: i64) -> bool {
        !self.access_token.trim().is_empty()
            && self
                .access_expires_at
                .is_none_or(|expires_at| expires_at > now + skew_seconds)
    }

    pub fn refresh_token_valid_at(&self, now: i64) -> bool {
        self.refresh_token
            .as_deref()
            .is_some_and(|token| !token.trim().is_empty())
            && self
                .refresh_expires_at
                .is_none_or(|expires_at| expires_at > now)
    }

    pub fn metadata(&self) -> GithubAuthMetadata {
        GithubAuthMetadata {
            login: self.login.clone(),
            access_expires_at: self.access_expires_at,
            refresh_expires_at: self.refresh_expires_at,
            saved_at: self.saved_at,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubAuthMetadata {
    pub login: Option<String>,
    pub access_expires_at: Option<i64>,
    pub refresh_expires_at: Option<i64>,
    pub saved_at: i64,
}

#[derive(Debug, Default, Clone, Copy)]
pub struct GithubTokenStore;

impl GithubTokenStore {
    pub fn load(&self) -> Result<Option<StoredGithubToken>> {
        let Some(bytes) = read_keychain_password()? else {
            return Ok(None);
        };
        let token: StoredGithubToken =
            serde_json::from_slice(&bytes).context("GitHub token keychain payload is invalid")?;
        Ok(Some(token))
    }

    pub fn save(&self, token: &StoredGithubToken) -> Result<()> {
        let bytes = serde_json::to_vec(token)?;
        write_keychain_password(&bytes)?;
        write_metadata(&token.metadata())
    }

    pub fn delete(&self) -> Result<()> {
        delete_keychain_password()?;
        let path = paths::github_auth_metadata_path()?;
        match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e).with_context(|| format!("failed to remove {}", path.display())),
        }
    }

    pub fn load_metadata(&self) -> Result<Option<GithubAuthMetadata>> {
        let path = paths::github_auth_metadata_path()?;
        let contents = match fs::read_to_string(&path) {
            Ok(contents) => contents,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e).with_context(|| format!("failed to read {}", path.display())),
        };
        serde_json::from_str(&contents)
            .map(Some)
            .with_context(|| format!("failed to parse {}", path.display()))
    }
}

fn write_metadata(metadata: &GithubAuthMetadata) -> Result<()> {
    let path = paths::github_auth_metadata_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    let contents = serde_json::to_string_pretty(metadata)?;
    fs::write(&path, contents).with_context(|| format!("failed to write {}", path.display()))
}

// Keychain access goes through the Apple-signed `security` CLI instead of
// security-framework. The keychain sees `security` as the client, so items it
// creates stay readable from every Monica binary — the ad-hoc CLI, the
// self-signed app bundle, and freshly rebuilt dev binaries — without ACL
// prompts. Direct framework access ties items to each binary's code signature:
// the legacy keychain re-prompts on every rebuild, and the data protection
// keychain cannot be shared across differently-signed binaries at all.
#[cfg(target_os = "macos")]
const SECURITY_BIN: &str = "/usr/bin/security";

/// `security` exit code for errSecItemNotFound.
#[cfg(target_os = "macos")]
const EXIT_ITEM_NOT_FOUND: i32 = 44;

#[cfg(target_os = "macos")]
fn read_keychain_password() -> Result<Option<Vec<u8>>> {
    let output = std::process::Command::new(SECURITY_BIN)
        .args([
            "find-generic-password",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            KEYCHAIN_ACCOUNT,
            "-w",
        ])
        .output()
        .context("failed to run `security find-generic-password`")?;

    if !output.status.success() {
        if output.status.code() == Some(EXIT_ITEM_NOT_FOUND) {
            return Ok(None);
        }
        return Err(security_error("find-generic-password", &output));
    }

    let mut bytes = output.stdout;
    if bytes.last() == Some(&b'\n') {
        bytes.pop();
    }
    if bytes.is_empty() {
        return Ok(None);
    }
    Ok(Some(bytes))
}

#[cfg(target_os = "macos")]
fn security_error(subcommand: &str, output: &std::process::Output) -> anyhow::Error {
    let stderr = String::from_utf8_lossy(&output.stderr);
    anyhow!(
        "`security {subcommand}` failed ({}): {}",
        output.status,
        stderr.trim()
    )
}

#[cfg(not(target_os = "macos"))]
fn read_keychain_password() -> Result<Option<Vec<u8>>> {
    Err(anyhow!(
        "Monica GitHub token storage currently supports macOS Keychain only; set MONICA_GITHUB_TOKEN on this platform"
    ))
}

#[cfg(target_os = "macos")]
fn write_keychain_password(bytes: &[u8]) -> Result<()> {
    let payload =
        std::str::from_utf8(bytes).context("GitHub token keychain payload is not valid UTF-8")?;
    let output = std::process::Command::new(SECURITY_BIN)
        .args([
            "add-generic-password",
            "-U",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            KEYCHAIN_ACCOUNT,
            "-w",
            payload,
        ])
        .output()
        .context("failed to run `security add-generic-password`")?;
    if !output.status.success() {
        return Err(security_error("add-generic-password", &output));
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn write_keychain_password(_bytes: &[u8]) -> Result<()> {
    Err(anyhow!(
        "Monica GitHub token storage currently supports macOS Keychain only; set MONICA_GITHUB_TOKEN on this platform"
    ))
}

#[cfg(target_os = "macos")]
fn delete_keychain_password() -> Result<()> {
    let output = std::process::Command::new(SECURITY_BIN)
        .args([
            "delete-generic-password",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            KEYCHAIN_ACCOUNT,
        ])
        .output()
        .context("failed to run `security delete-generic-password`")?;
    if !output.status.success() && output.status.code() != Some(EXIT_ITEM_NOT_FOUND) {
        return Err(security_error("delete-generic-password", &output));
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn delete_keychain_password() -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::StoredGithubToken;

    #[test]
    fn access_validity_honors_expiry_skew() {
        let mut token = StoredGithubToken {
            access_token: "ghu_access".to_string(),
            access_expires_at: Some(1_000),
            refresh_token: Some("ghr_refresh".to_string()),
            refresh_expires_at: Some(10_000),
            login: Some("ashigirl96".to_string()),
            saved_at: 10,
        };
        assert!(token.access_token_valid_at(900, 60));
        assert!(!token.access_token_valid_at(950, 60));
        token.access_expires_at = None;
        assert!(token.access_token_valid_at(100_000, 60));
        token.access_token.clear();
        assert!(!token.access_token_valid_at(1, 60));
    }

    #[test]
    fn refresh_validity_requires_token_and_future_expiry() {
        let token = StoredGithubToken {
            access_token: "ghu_access".to_string(),
            access_expires_at: Some(1),
            refresh_token: Some("ghr_refresh".to_string()),
            refresh_expires_at: Some(10_000),
            login: None,
            saved_at: 10,
        };
        assert!(token.refresh_token_valid_at(9_999));
        assert!(!token.refresh_token_valid_at(10_000));
    }
}
