use std::sync::{Once, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Context, Result};
use monica_application::{AuthGateway, GithubAuthStatus, GithubDeviceFlow};

use reqwest::header::{ACCEPT, USER_AGENT};
use serde::Deserialize;
use tokio::sync::Mutex;

use crate::secrets::{GithubTokenStore, StoredGithubToken};

const DEFAULT_CLIENT_ID: &str = "Ov23li1kTGsVVhQftGso";
const DEFAULT_SCOPES: &str = "repo";
const DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const USER_URL: &str = "https://api.github.com/user";
const DEVICE_GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:device_code";
const REFRESH_GRANT_TYPE: &str = "refresh_token";
const ACCESS_TOKEN_SKEW_SECONDS: i64 = 60;

static TOKEN_CACHE: OnceLock<Mutex<Option<StoredGithubToken>>> = OnceLock::new();
static REFRESH_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static CRYPTO_PROVIDER_INIT: Once = Once::new();

#[derive(Debug, Clone, PartialEq, Eq)]
enum DevicePoll {
    Pending,
    SlowDown { interval: Option<u64> },
    Authorized(StoredGithubToken),
}

#[derive(Debug, Default, Clone, Copy)]
pub struct GithubTokenProvider {
    store: GithubTokenStore,
}

pub type KeychainAuthGateway = GithubTokenProvider;

impl GithubTokenProvider {
    pub fn new() -> Self {
        Self {
            store: GithubTokenStore,
        }
    }

    pub fn status(&self) -> GithubAuthStatus {
        if env_token().is_some() {
            return GithubAuthStatus {
                authenticated: true,
                source: "env".to_string(),
                login: None,
                access_expires_at: None,
                refresh_expires_at: None,
                reauth_required: false,
                message: Some("Using MONICA_GITHUB_TOKEN".to_string()),
            };
        }

        match self.store.load() {
            Ok(Some(token)) => {
                let now = now_epoch_seconds();
                let usable = token.access_token_valid_at(now, ACCESS_TOKEN_SKEW_SECONDS)
                    || token.refresh_token_valid_at(now);
                GithubAuthStatus {
                    authenticated: usable,
                    source: "keychain".to_string(),
                    login: token.login,
                    access_expires_at: token.access_expires_at,
                    refresh_expires_at: token.refresh_expires_at,
                    reauth_required: !usable,
                    message: (!usable).then(|| {
                        "GitHub token expired; run `monica auth github login`".to_string()
                    }),
                }
            }
            Ok(None) => GithubAuthStatus {
                authenticated: false,
                source: "none".to_string(),
                login: None,
                access_expires_at: None,
                refresh_expires_at: None,
                reauth_required: false,
                message: Some("Run `monica auth github login` to connect GitHub".to_string()),
            },
            Err(e) => GithubAuthStatus {
                authenticated: false,
                source: "keychain".to_string(),
                login: None,
                access_expires_at: None,
                refresh_expires_at: None,
                reauth_required: true,
                message: Some(format!("{e:#}; run `monica auth github login`")),
            },
        }
    }

    pub async fn access_token(&self) -> Result<String> {
        if let Some(token) = env_token() {
            return Ok(token);
        }

        if let Some(token) = cached_valid_access_token().await {
            return Ok(token);
        }

        let _refresh_guard = refresh_lock().lock().await;
        if let Some(token) = cached_valid_access_token().await {
            return Ok(token);
        }

        let now = now_epoch_seconds();
        let stored = match self.store.load() {
            Ok(Some(stored)) => stored,
            Ok(None) => return Err(reauth_error()),
            Err(e) => {
                // A read/parse error may be transient (locked Keychain) or a
                // recoverable migration; do not destroy a possibly-valid refresh
                // token. A fresh `login` overwrites a genuinely corrupt payload.
                clear_cached_token().await;
                return Err(anyhow!("{e:#}; run `monica auth github login`"));
            }
        };

        if stored.access_token_valid_at(now, ACCESS_TOKEN_SKEW_SECONDS) {
            set_cached_token(stored.clone()).await;
            return Ok(stored.access_token);
        }

        if !stored.refresh_token_valid_at(now) {
            let _ = self.store.delete();
            clear_cached_token().await;
            return Err(reauth_error());
        }

        let refresh_token = stored.refresh_token.clone().ok_or_else(reauth_error)?;
        match refresh_access_token(&refresh_token, stored.login.as_deref()).await {
            Ok(refreshed) => {
                self.store.save(&refreshed)?;
                set_cached_token(refreshed.clone()).await;
                Ok(refreshed.access_token)
            }
            Err(RefreshFailure::Rejected(e)) => {
                let _ = self.store.delete();
                clear_cached_token().await;
                Err(anyhow!("{e:#}; run `monica auth github login`"))
            }
            Err(RefreshFailure::Transient(e)) => {
                clear_cached_token().await;
                Err(e.context("GitHub token refresh failed; check your connection and try again"))
            }
        }
    }

    pub async fn begin_device_flow(&self) -> Result<GithubDeviceFlow> {
        let response: DeviceCodeResponse = http_client()
            .post(DEVICE_CODE_URL)
            .header(ACCEPT, "application/json")
            .header(USER_AGENT, "Monica")
            .form(&[("client_id", client_id()), ("scope", scopes())])
            .send()
            .await
            .context("failed to start GitHub device flow")?
            .json()
            .await
            .context("failed to parse GitHub device flow response")?;

        if let Some(error) = response.error {
            return Err(oauth_error(error, response.error_description));
        }

        let now = now_epoch_seconds();
        Ok(GithubDeviceFlow {
            user_code: response
                .user_code
                .ok_or_else(|| anyhow!("GitHub device flow response omitted user_code"))?,
            verification_uri: response
                .verification_uri
                .ok_or_else(|| anyhow!("GitHub device flow response omitted verification_uri"))?,
            expires_at: now.saturating_add(
                response
                    .expires_in
                    .ok_or_else(|| anyhow!("GitHub device flow response omitted expires_in"))?,
            ),
            interval: response.interval.unwrap_or(5).max(1) as u64,
            device_code: response
                .device_code
                .ok_or_else(|| anyhow!("GitHub device flow response omitted device_code"))?,
        })
    }

    pub async fn wait_for_device_flow(&self, flow: &GithubDeviceFlow) -> Result<GithubAuthStatus> {
        let mut interval = flow.interval.max(1);
        loop {
            if now_epoch_seconds() >= flow.expires_at {
                return Err(anyhow!("GitHub device code expired; run login again"));
            }
            tokio::time::sleep(Duration::from_secs(interval)).await;
            match poll_device_flow(flow).await? {
                DevicePoll::Pending => {}
                DevicePoll::SlowDown { interval: next } => {
                    interval = next.unwrap_or(interval + 5).max(interval + 5);
                }
                DevicePoll::Authorized(token) => {
                    self.store.save(&token)?;
                    set_cached_token(token.clone()).await;
                    return Ok(self.status());
                }
            }
        }
    }

    pub async fn logout(&self) -> Result<()> {
        self.store.delete()?;
        clear_cached_token().await;
        Ok(())
    }
}

impl AuthGateway for GithubTokenProvider {
    fn status(&self) -> GithubAuthStatus {
        GithubTokenProvider::status(self)
    }

    fn begin_device_flow<'a>(
        &'a self,
    ) -> monica_application::ports::BoxFuture<'a, Result<GithubDeviceFlow>> {
        Box::pin(async move { GithubTokenProvider::begin_device_flow(self).await })
    }

    fn wait_for_device_flow<'a>(
        &'a self,
        flow: &'a GithubDeviceFlow,
    ) -> monica_application::ports::BoxFuture<'a, Result<GithubAuthStatus>> {
        Box::pin(async move { GithubTokenProvider::wait_for_device_flow(self, flow).await })
    }

    fn logout<'a>(&'a self) -> monica_application::ports::BoxFuture<'a, Result<()>> {
        Box::pin(async move { GithubTokenProvider::logout(self).await })
    }
}

fn client_id() -> String {
    std::env::var("MONICA_GITHUB_CLIENT_ID")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_CLIENT_ID.to_string())
}

fn scopes() -> String {
    std::env::var("MONICA_GITHUB_SCOPES")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_SCOPES.to_string())
}

fn env_token() -> Option<String> {
    std::env::var("MONICA_GITHUB_TOKEN")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn http_client() -> reqwest::Client {
    install_crypto_provider();
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

// reqwest is built with `rustls-no-provider`, so the single rustls instance has
// no default CryptoProvider and would panic on first TLS use. Install ring to
// match octocrab's `rustls-ring`; ignore the error if another caller won the race.
fn install_crypto_provider() {
    CRYPTO_PROVIDER_INIT.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

async fn cached_valid_access_token() -> Option<String> {
    let cache = token_cache().lock().await;
    cache
        .as_ref()
        .filter(|token| token.access_token_valid_at(now_epoch_seconds(), ACCESS_TOKEN_SKEW_SECONDS))
        .map(|token| token.access_token.clone())
}

async fn set_cached_token(token: StoredGithubToken) {
    *token_cache().lock().await = Some(token);
}

async fn clear_cached_token() {
    *token_cache().lock().await = None;
}

fn token_cache() -> &'static Mutex<Option<StoredGithubToken>> {
    TOKEN_CACHE.get_or_init(|| Mutex::new(None))
}

fn refresh_lock() -> &'static Mutex<()> {
    REFRESH_LOCK.get_or_init(|| Mutex::new(()))
}

/// Distinguishes a definitive GitHub rejection of the stored refresh token (the
/// credentials are dead and must be cleared) from a transient failure (network,
/// 5xx, malformed body) where the refresh token should be kept so the next
/// attempt can retry — GitHub rotates refresh tokens, so discarding a valid one
/// on a network blip would force an avoidable full re-login.
enum RefreshFailure {
    Rejected(anyhow::Error),
    Transient(anyhow::Error),
}

async fn refresh_access_token(
    refresh_token: &str,
    previous_login: Option<&str>,
) -> std::result::Result<StoredGithubToken, RefreshFailure> {
    let response: AccessTokenResponse = http_client()
        .post(ACCESS_TOKEN_URL)
        .header(ACCEPT, "application/json")
        .header(USER_AGENT, "Monica")
        .form(&[
            ("client_id", client_id()),
            ("grant_type", REFRESH_GRANT_TYPE.to_string()),
            ("refresh_token", refresh_token.to_string()),
        ])
        .send()
        .await
        .context("failed to refresh GitHub access token")
        .map_err(RefreshFailure::Transient)?
        .json()
        .await
        .context("failed to parse GitHub token refresh response")
        .map_err(RefreshFailure::Transient)?;

    if let Some(error) = response.error {
        return Err(RefreshFailure::Rejected(oauth_error(
            error,
            response.error_description,
        )));
    }

    let now = now_epoch_seconds();
    let login = previous_login.map(ToString::to_string);
    stored_token_from_response(response, login, now).map_err(RefreshFailure::Transient)
}

async fn poll_device_flow(flow: &GithubDeviceFlow) -> Result<DevicePoll> {
    let response: AccessTokenResponse = http_client()
        .post(ACCESS_TOKEN_URL)
        .header(ACCEPT, "application/json")
        .header(USER_AGENT, "Monica")
        .form(&[
            ("client_id", client_id()),
            ("device_code", flow.device_code.clone()),
            ("grant_type", DEVICE_GRANT_TYPE.to_string()),
        ])
        .send()
        .await
        .context("failed to poll GitHub device flow")?
        .json()
        .await
        .context("failed to parse GitHub device flow poll response")?;

    match response.error.as_deref() {
        Some("authorization_pending") => Ok(DevicePoll::Pending),
        Some("slow_down") => Ok(DevicePoll::SlowDown {
            interval: response.interval.map(|interval| interval.max(1) as u64),
        }),
        Some("expired_token" | "token_expired") => {
            Err(anyhow!("GitHub device code expired; run login again"))
        }
        Some("access_denied") => Err(anyhow!("GitHub authorization was canceled")),
        Some(error) => Err(oauth_error(
            error.to_string(),
            response.error_description.clone(),
        )),
        None => token_from_response(response)
            .await
            .map(DevicePoll::Authorized),
    }
}

async fn token_from_response(response: AccessTokenResponse) -> Result<StoredGithubToken> {
    if let Some(error) = response.error {
        return Err(oauth_error(error, response.error_description));
    }
    let access_token = response
        .access_token
        .as_deref()
        .filter(|token| !token.trim().is_empty())
        .ok_or_else(|| anyhow!("GitHub token response omitted access_token"))?;
    let now = now_epoch_seconds();
    let login = current_user_login(access_token).await.ok();
    stored_token_from_response(response, login, now)
}

fn stored_token_from_response(
    response: AccessTokenResponse,
    login: Option<String>,
    now: i64,
) -> Result<StoredGithubToken> {
    if let Some(error) = response.error {
        return Err(oauth_error(error, response.error_description));
    }
    let access_token = response
        .access_token
        .filter(|token| !token.trim().is_empty())
        .ok_or_else(|| anyhow!("GitHub token response omitted access_token"))?;
    Ok(StoredGithubToken {
        access_token,
        access_expires_at: response
            .expires_in
            .map(|seconds| now.saturating_add(seconds)),
        refresh_token: response.refresh_token,
        refresh_expires_at: response
            .refresh_token_expires_in
            .map(|seconds| now.saturating_add(seconds)),
        login,
        saved_at: now,
    })
}

async fn current_user_login(access_token: &str) -> Result<String> {
    #[derive(Deserialize)]
    struct UserResponse {
        login: String,
    }

    let response: UserResponse = http_client()
        .get(USER_URL)
        .header(ACCEPT, "application/vnd.github+json")
        .header(USER_AGENT, "Monica")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .bearer_auth(access_token)
        .send()
        .await
        .context("failed to fetch GitHub user")?
        .error_for_status()
        .context("failed to authenticate GitHub user token")?
        .json()
        .await
        .context("failed to parse GitHub user response")?;
    Ok(response.login)
}

fn reauth_error() -> anyhow::Error {
    anyhow!("GitHub login required; run `monica auth github login`")
}

fn oauth_error(error: String, description: Option<String>) -> anyhow::Error {
    match description {
        Some(description) if !description.trim().is_empty() => {
            anyhow!("GitHub OAuth error {error}: {description}")
        }
        _ => anyhow!("GitHub OAuth error {error}"),
    }
}

fn now_epoch_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .min(i64::MAX as u64) as i64
}

#[derive(Debug, Deserialize)]
struct DeviceCodeResponse {
    device_code: Option<String>,
    user_code: Option<String>,
    verification_uri: Option<String>,
    expires_in: Option<i64>,
    interval: Option<i64>,
    error: Option<String>,
    error_description: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AccessTokenResponse {
    access_token: Option<String>,
    expires_in: Option<i64>,
    refresh_token: Option<String>,
    refresh_token_expires_in: Option<i64>,
    error: Option<String>,
    error_description: Option<String>,
    interval: Option<i64>,
}

#[cfg(test)]
mod tests {
    use super::{oauth_error, stored_token_from_response, AccessTokenResponse};

    #[test]
    fn oauth_error_keeps_description() {
        let msg = format!(
            "{:#}",
            oauth_error(
                "bad_refresh_token".to_string(),
                Some("The refresh token is invalid".to_string())
            )
        );
        assert!(msg.contains("bad_refresh_token"), "{msg}");
        assert!(msg.contains("The refresh token is invalid"), "{msg}");
    }

    #[test]
    fn token_response_builds_rotated_token_snapshot() {
        let token = stored_token_from_response(
            AccessTokenResponse {
                access_token: Some("new_access".to_string()),
                expires_in: Some(28_800),
                refresh_token: Some("new_refresh".to_string()),
                refresh_token_expires_in: Some(15_768_000),
                error: None,
                error_description: None,
                interval: None,
            },
            Some("ashigirl96".to_string()),
            100,
        )
        .unwrap();

        assert_eq!(token.access_token, "new_access");
        assert_eq!(token.access_expires_at, Some(28_900));
        assert_eq!(token.refresh_token.as_deref(), Some("new_refresh"));
        assert_eq!(token.refresh_expires_at, Some(15_768_100));
        assert_eq!(token.login.as_deref(), Some("ashigirl96"));
    }

    #[test]
    fn token_response_rejects_oauth_error() {
        let err = stored_token_from_response(
            AccessTokenResponse {
                access_token: Some("old_access".to_string()),
                expires_in: None,
                refresh_token: None,
                refresh_token_expires_in: None,
                error: Some("bad_refresh_token".to_string()),
                error_description: Some("invalid".to_string()),
                interval: None,
            },
            None,
            100,
        )
        .unwrap_err();
        assert!(format!("{err:#}").contains("bad_refresh_token"));
    }
}
