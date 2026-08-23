use std::process::Command;
use std::sync::OnceLock;

use anyhow::{anyhow, Context, Result};
use monica_application::{AuthGateway, GithubAuthStatus};

// GUI launches (Finder/Dock) inherit launchd's minimal PATH, which has no
// Homebrew entry — so a bare `gh` lookup fails there and the well-known
// install locations must be tried explicitly.
const GH_CANDIDATES: &[&str] = &["gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh"];

// gh's OAuth tokens have no expiry; they only change on `gh auth login`/refresh,
// so a process-lifetime cache is safe. Failures are not cached — every call
// retries until gh yields a token.
static TOKEN_CACHE: OnceLock<String> = OnceLock::new();

/// GitHub token source backed by the GitHub CLI: resolves `gh` and runs
/// `gh auth token`, so Monica rides gh's stored credentials instead of
/// managing its own OAuth app.
#[derive(Debug, Default, Clone, Copy)]
pub struct GithubTokenProvider;

impl GithubTokenProvider {
    pub fn new() -> Self {
        Self
    }

    pub fn access_token(&self) -> Result<String> {
        if let Some(token) = TOKEN_CACHE.get() {
            return Ok(token.clone());
        }
        let token = gh_auth_token()?;
        Ok(TOKEN_CACHE.get_or_init(|| token).clone())
    }

    pub fn status(&self) -> GithubAuthStatus {
        match self.access_token() {
            Ok(_) => GithubAuthStatus {
                authenticated: true,
                message: None,
            },
            Err(e) => GithubAuthStatus {
                authenticated: false,
                message: Some(format!("{e:#}")),
            },
        }
    }
}

impl AuthGateway for GithubTokenProvider {
    fn status(&self) -> GithubAuthStatus {
        GithubTokenProvider::status(self)
    }
}

fn gh_auth_token() -> Result<String> {
    // Monica only talks to api.github.com; without --hostname, gh would hand
    // out its default host's token, which on a GHE-configured gh is unusable
    // here and would fail with a misleading 401.
    let output = run_gh(&["auth", "token", "--hostname", "github.com"])?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stderr = stderr.trim();
        return Err(anyhow!(
            "`gh auth token` failed ({}): {}; run `gh auth login`",
            output.status,
            if stderr.is_empty() { "no error output" } else { stderr }
        ));
    }
    let token = String::from_utf8(output.stdout)
        .context("`gh auth token` returned non-UTF-8 output")?
        .trim()
        .to_string();
    if token.is_empty() {
        return Err(anyhow!("`gh auth token` returned no token; run `gh auth login`"));
    }
    Ok(token)
}

fn run_gh(args: &[&str]) -> Result<std::process::Output> {
    // A broken candidate (non-executable stub, wrong-arch binary) must not
    // preempt a working one later in the list, so spawn errors other than
    // NotFound are remembered and surfaced only when every candidate fails.
    let mut spawn_error: Option<(&str, std::io::Error)> = None;
    for candidate in GH_CANDIDATES {
        match Command::new(candidate).args(args).output() {
            Ok(output) => return Ok(output),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => {
                if spawn_error.is_none() {
                    spawn_error = Some((*candidate, e));
                }
            }
        }
    }
    match spawn_error {
        Some((candidate, e)) => {
            Err(anyhow!(e)).context(format!("failed to run `{candidate} {}`", args.join(" ")))
        }
        None => Err(anyhow!(
            "GitHub CLI (gh) not found; install it and run `gh auth login`"
        )),
    }
}
