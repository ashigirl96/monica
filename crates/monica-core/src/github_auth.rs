use std::fs;
use std::io::ErrorKind;

use anyhow::{anyhow, Context, Result};
use octocrab::Octocrab;
use serde::{Deserialize, Serialize};
use serde_json::json;

/// Abstraction over where Monica's GitHub token lives, so resolution and the save flow can be
/// exercised without touching the on-disk token file.
pub trait GithubTokenStore: Send + Sync {
    fn read(&self) -> Result<Option<String>>;
    fn write(&self, token: &str) -> Result<()>;
    fn delete(&self) -> Result<()>;
}

/// Stores the token in `<MONICA_HOME>/auth/github_token`, owner-only (`0600`).
pub struct FileTokenStore;

impl GithubTokenStore for FileTokenStore {
    fn read(&self) -> Result<Option<String>> {
        let path = crate::paths::github_token_path()?;
        match fs::read_to_string(&path) {
            Ok(contents) => {
                let token = contents.trim().to_string();
                Ok((!token.is_empty()).then_some(token))
            }
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
            Err(e) => Err(anyhow::Error::new(e)
                .context(format!("failed to read GitHub token at {}", path.display()))),
        }
    }

    fn write(&self, token: &str) -> Result<()> {
        let path = crate::paths::github_token_path()?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("failed to create {}", parent.display()))?;
        }
        write_owner_only(&path, token)
            .with_context(|| format!("failed to write GitHub token at {}", path.display()))
    }

    fn delete(&self) -> Result<()> {
        let path = crate::paths::github_token_path()?;
        match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
            Err(e) => Err(anyhow::Error::new(e)
                .context(format!("failed to delete GitHub token at {}", path.display()))),
        }
    }
}

#[cfg(unix)]
fn write_owner_only(path: &std::path::Path, token: &str) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    // `mode` only applies when the file is created; enforce it for a pre-existing file too.
    file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    file.write_all(token.as_bytes())
}

#[cfg(not(unix))]
fn write_owner_only(path: &std::path::Path, token: &str) -> std::io::Result<()> {
    fs::write(path, token.as_bytes())
}

/// Resolve the token PR sync should use. Only Monica's own token file is consulted — never
/// `gh`'s config, the `gh:github.com` Keychain item, or `GH_TOKEN`/`GITHUB_TOKEN`.
pub fn resolve_pr_sync_token() -> Result<Option<String>> {
    resolve_token_with(&FileTokenStore)
}

fn resolve_token_with(store: &dyn GithubTokenStore) -> Result<Option<String>> {
    store.read()
}

/// Distinguishes a missing/invalid token from a transient failure. Matches phrases unique to an
/// auth rejection rather than a bare `401`, which would also hit issue/PR numbers carried in the
/// error context (e.g. `o/r#401`).
pub fn is_auth_error(err: &anyhow::Error) -> bool {
    let message = format!("{err:#}").to_ascii_lowercase();
    message.contains("bad credentials")
        || message.contains("401 unauthorized")
        || message.contains("requires authentication")
}

#[derive(Debug, Clone, Serialize)]
pub struct GithubAuthStatus {
    pub authenticated: bool,
    pub login: Option<String>,
}

/// The token is only stored if it authenticates successfully, so PR sync never adopts a token that
/// would immediately fail with `Bad credentials`.
pub async fn save_github_token(token: String) -> Result<GithubAuthStatus> {
    save_github_token_with(&FileTokenStore, token).await
}

async fn save_github_token_with(
    store: &dyn GithubTokenStore,
    token: String,
) -> Result<GithubAuthStatus> {
    let token = validate_token_input(&token)?.to_string();
    let login = fetch_viewer_login(&token).await?;
    store.write(&token)?;
    Ok(GithubAuthStatus {
        authenticated: true,
        login: Some(login),
    })
}

fn validate_token_input(token: &str) -> Result<&str> {
    let trimmed = token.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("token is empty"));
    }
    Ok(trimmed)
}

async fn fetch_viewer_login(token: &str) -> Result<String> {
    let crab = Octocrab::builder().personal_token(token.to_string()).build()?;
    let payload = json!({ "query": "query { viewer { login } }" });
    let response: ViewerResponse = crab.graphql(&payload).await.map_err(|e| {
        let err = anyhow::Error::new(e);
        if is_auth_error(&err) {
            anyhow!("invalid GitHub token")
        } else {
            err.context("failed to validate GitHub token")
        }
    })?;
    Ok(response.viewer.login)
}

pub fn github_auth_status() -> Result<GithubAuthStatus> {
    github_auth_status_with(&FileTokenStore)
}

fn github_auth_status_with(store: &dyn GithubTokenStore) -> Result<GithubAuthStatus> {
    Ok(GithubAuthStatus {
        authenticated: resolve_token_with(store)?.is_some(),
        login: None,
    })
}

pub fn github_sign_out() -> Result<()> {
    github_sign_out_with(&FileTokenStore)
}

fn github_sign_out_with(store: &dyn GithubTokenStore) -> Result<()> {
    store.delete()
}

#[derive(Debug, Deserialize)]
struct ViewerResponse {
    viewer: Viewer,
}

#[derive(Debug, Deserialize)]
struct Viewer {
    login: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct FakeStore {
        token: Mutex<Option<String>>,
    }

    impl FakeStore {
        fn with(token: &str) -> Self {
            Self {
                token: Mutex::new(Some(token.to_string())),
            }
        }

        fn current(&self) -> Option<String> {
            self.token.lock().unwrap().clone()
        }
    }

    impl GithubTokenStore for FakeStore {
        fn read(&self) -> Result<Option<String>> {
            Ok(self.token.lock().unwrap().clone())
        }

        fn write(&self, token: &str) -> Result<()> {
            *self.token.lock().unwrap() = Some(token.to_string());
            Ok(())
        }

        fn delete(&self) -> Result<()> {
            *self.token.lock().unwrap() = None;
            Ok(())
        }
    }

    #[test]
    fn resolve_returns_stored_token() {
        let store = FakeStore::with("ghp_token");
        assert_eq!(
            resolve_token_with(&store).unwrap().as_deref(),
            Some("ghp_token")
        );
    }

    #[test]
    fn file_store_round_trips_owner_only() {
        let _env = crate::paths::test_env_guard();
        let home = crate::test_support::unique_tmp("auth");
        std::env::set_var("MONICA_HOME", &home);

        let store = FileTokenStore;
        assert_eq!(store.read().unwrap(), None);

        store.write("ghp_secret").unwrap();
        assert_eq!(store.read().unwrap().as_deref(), Some("ghp_secret"));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let path = crate::paths::github_token_path().unwrap();
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }

        store.delete().unwrap();
        assert_eq!(store.read().unwrap(), None);
        store.delete().unwrap();

        std::env::remove_var("MONICA_HOME");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn resolve_returns_none_when_store_empty() {
        let store = FakeStore::default();
        assert_eq!(resolve_token_with(&store).unwrap(), None);
    }

    #[test]
    fn validate_token_input_rejects_blank() {
        assert!(validate_token_input("   ").is_err());
        assert!(validate_token_input("").is_err());
    }

    #[test]
    fn validate_token_input_trims() {
        assert_eq!(validate_token_input("  ghp_x  ").unwrap(), "ghp_x");
    }

    #[test]
    fn is_auth_error_detects_bad_credentials() {
        assert!(is_auth_error(&anyhow!("GitHub said: Bad credentials")));
        assert!(is_auth_error(&anyhow!("HTTP status 401 Unauthorized")));
        assert!(is_auth_error(&anyhow!("Requires authentication")));
    }

    #[test]
    fn is_auth_error_ignores_unrelated_failures() {
        assert!(!is_auth_error(&anyhow!("connection reset by peer")));
        assert!(!is_auth_error(&anyhow!("GitHub repository was not found")));
    }

    #[test]
    fn is_auth_error_does_not_match_issue_numbers() {
        assert!(!is_auth_error(&anyhow!(
            "failed to fetch linked pull requests for o/r#401"
        )));
        assert!(!is_auth_error(&anyhow!("connection refused: port 4010")));
    }

    #[test]
    fn viewer_response_parses_login() {
        let response: ViewerResponse =
            serde_json::from_value(json!({ "viewer": { "login": "ashigirl96" } })).unwrap();
        assert_eq!(response.viewer.login, "ashigirl96");
    }

    #[test]
    fn auth_status_reflects_token_presence() {
        assert!(
            github_auth_status_with(&FakeStore::with("ghp_x"))
                .unwrap()
                .authenticated
        );
        assert!(
            !github_auth_status_with(&FakeStore::default())
                .unwrap()
                .authenticated
        );
    }

    #[test]
    fn sign_out_clears_token_and_is_idempotent() {
        let store = FakeStore::with("ghp_x");
        github_sign_out_with(&store).unwrap();
        assert_eq!(store.current(), None);
        github_sign_out_with(&store).unwrap();
    }

    #[tokio::test]
    async fn save_rejects_blank_token_without_writing() {
        let store = FakeStore::default();
        let result = save_github_token_with(&store, "   ".to_string()).await;
        assert!(result.is_err());
        assert_eq!(store.current(), None);
    }
}
