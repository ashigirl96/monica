use std::fs;

#[cfg(not(target_os = "macos"))]
use anyhow::anyhow;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::filesystem::paths;

const KEYCHAIN_SERVICE: &str = "monica.github";
const KEYCHAIN_ACCOUNT: &str = "github.com";
const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

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

#[cfg(target_os = "macos")]
fn protected_options() -> security_framework::passwords::PasswordOptions {
    let mut opts = security_framework::passwords::PasswordOptions::new_generic_password(
        KEYCHAIN_SERVICE,
        KEYCHAIN_ACCOUNT,
    );
    opts.use_protected_keychain();
    opts
}

#[cfg(target_os = "macos")]
fn read_keychain_password() -> Result<Option<Vec<u8>>> {
    use security_framework::passwords;

    match passwords::generic_password(protected_options()) {
        Ok(bytes) => return Ok(Some(bytes)),
        Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => {}
        Err(e) => {
            return Err(e).context("failed to read GitHub token from data protection keychain")
        }
    }
    migrate_legacy_keychain_item()
}

/// Read the token from the legacy keychain via `security` CLI (Apple-signed,
/// so it bypasses per-app ACL prompts) and move it to the data protection
/// keychain.  Returns the token bytes on success, `None` if no legacy item
/// exists.
#[cfg(target_os = "macos")]
fn migrate_legacy_keychain_item() -> Result<Option<Vec<u8>>> {
    use std::process::Command;

    use security_framework::passwords;

    let output = Command::new("security")
        .args([
            "find-generic-password",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            KEYCHAIN_ACCOUNT,
            "-w",
        ])
        .output()
        .context("failed to run `security` CLI for keychain migration")?;

    if !output.status.success() {
        return Ok(None);
    }

    let mut bytes = output.stdout;
    if bytes.last() == Some(&b'\n') {
        bytes.pop();
    }
    if bytes.is_empty() {
        return Ok(None);
    }

    let _ = passwords::set_generic_password_options(&bytes, protected_options());

    let _ = Command::new("security")
        .args([
            "delete-generic-password",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            KEYCHAIN_ACCOUNT,
        ])
        .output();

    Ok(Some(bytes))
}

#[cfg(not(target_os = "macos"))]
fn read_keychain_password() -> Result<Option<Vec<u8>>> {
    Err(anyhow!(
        "Monica GitHub token storage currently supports macOS Keychain only; set MONICA_GITHUB_TOKEN on this platform"
    ))
}

#[cfg(target_os = "macos")]
fn write_keychain_password(bytes: &[u8]) -> Result<()> {
    security_framework::passwords::set_generic_password_options(bytes, protected_options())
        .context("failed to save Monica GitHub token to macOS Keychain")
}

#[cfg(not(target_os = "macos"))]
fn write_keychain_password(_bytes: &[u8]) -> Result<()> {
    Err(anyhow!(
        "Monica GitHub token storage currently supports macOS Keychain only; set MONICA_GITHUB_TOKEN on this platform"
    ))
}

#[cfg(target_os = "macos")]
fn delete_keychain_password() -> Result<()> {
    use security_framework::passwords;

    match passwords::delete_generic_password_options(protected_options()) {
        Ok(()) => {}
        Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => {}
        Err(e) => {
            return Err(e)
                .context("failed to delete Monica GitHub token from data protection keychain")
        }
    }
    match passwords::delete_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) {
        Ok(()) => {}
        Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => {}
        Err(e) => Err(e).context("failed to delete Monica GitHub token from macOS Keychain")?,
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
