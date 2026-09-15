use std::sync::Once;
use std::time::{Duration, Instant};

use crate::exec::{redact, render, HTTP};

pub(crate) fn http_client(timeout: Duration) -> reqwest::Client {
    install_crypto_provider();
    reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .unwrap_or_else(|e| {
            // The fallback fails the same way rather than quietly dropping the timeout
            // (`Client::new` is `builder().build().expect(..)`), so this is the last thing said
            // before the process goes down.
            log::warn!(target: HTTP, "http client not built error={e}");
            reqwest::Client::new()
        })
}

/// Send a request and leave one line naming it, its status and how long it took. A non-2xx answer
/// warns even where the caller goes on to read the body: it is the boundary reporting what the
/// other side said, not a verdict on what the caller should do about it.
pub(crate) async fn send_logged(
    op: &str,
    request: reqwest::RequestBuilder,
) -> reqwest::Result<reqwest::Response> {
    let (client, built) = request.build_split();
    let request = match built {
        Ok(request) => request,
        Err(e) => {
            let fields = [("op", op.to_string()), ("error", safe_error(&e))];
            log::warn!(target: HTTP, "{}", render("http unsent", &fields));
            return Err(e);
        }
    };
    let mut fields = vec![
        ("op", op.to_string()),
        ("method", request.method().to_string()),
        ("url", safe_url(request.url())),
    ];

    let started = Instant::now();
    let result = client.execute(request).await;

    let level = match &result {
        Ok(response) => {
            fields.push(("status", response.status().as_u16().to_string()));
            if response.status().is_success() {
                log::Level::Debug
            } else {
                log::Level::Warn
            }
        }
        Err(e) => {
            fields.push(("status", "none".to_string()));
            fields.push(("error", safe_error(e)));
            log::Level::Warn
        }
    };
    fields.push(("duration_ms", started.elapsed().as_millis().to_string()));
    log::log!(target: HTTP, level, "{}", render("http", &fields));
    result
}

/// A reqwest error carries the URL it failed on and prints it verbatim (`" for url ({url})"`), so
/// sanitising the `url=` field alone would let the raw one back in through `error=`.
fn safe_error(error: &reqwest::Error) -> String {
    safe_error_text(&error.to_string(), error.url())
}

fn safe_error_text(text: &str, url: Option<&reqwest::Url>) -> String {
    let text = match url {
        Some(url) => text.replace(url.as_str(), &safe_url(url)),
        None => text.to_string(),
    };
    redact(&text).into_owned()
}

/// A URL fit to write down. These URLs come from whoever pasted a link, so the secrets they can
/// carry have no fixed shape — `https://user:pass@…`, `?token=…`, a presigned `X-Amz-Signature`.
/// Masking only the patterns we happen to know would leak the rest, so userinfo and every query
/// value go regardless of name; the keys stay, since which parameters were sent is the part worth
/// having when a fetch misbehaves.
fn safe_url(url: &reqwest::Url) -> String {
    let mut safe = url.clone();
    if !safe.username().is_empty() || safe.password().is_some() {
        let _ = safe.set_username("***");
        let _ = safe.set_password(None);
    }
    let masked = safe.query().map(|_| {
        safe.query_pairs()
            .map(|(key, _)| format!("{key}=***"))
            .collect::<Vec<_>>()
            .join("&")
    });
    if let Some(masked) = masked {
        safe.set_query(Some(&masked));
    }
    redact(safe.as_str()).into_owned()
}

// reqwest is built with `rustls-no-provider`, so the single rustls instance has
// no default CryptoProvider and would panic on first TLS use. Install ring to
// match octocrab's `rustls-ring`; ignore the error if another caller won the race.
fn install_crypto_provider() {
    static INIT: Once = Once::new();
    INIT.call_once(|| {
        if rustls::crypto::ring::default_provider().install_default().is_err() {
            log::debug!(target: HTTP, "crypto provider already installed by another caller");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{safe_error_text, safe_url};

    fn url(raw: &str) -> reqwest::Url {
        reqwest::Url::parse(raw).unwrap()
    }

    #[test]
    fn a_url_without_secrets_survives_intact() {
        assert_eq!(safe_url(&url("https://example.com/a/b")), "https://example.com/a/b");
    }

    #[test]
    fn userinfo_is_replaced_rather_than_carried_into_the_log() {
        let safe = safe_url(&url("https://alice:hunter2@example.com/a"));
        assert_eq!(safe, "https://***@example.com/a");
        assert!(!safe.contains("hunter2") && !safe.contains("alice"));
    }

    #[test]
    fn query_values_are_masked_whatever_they_are_named() {
        assert_eq!(
            safe_url(&url("https://example.com/p?token=s3cret&w=64&X-Amz-Signature=abc")),
            "https://example.com/p?token=***&w=***&X-Amz-Signature=***"
        );
    }

    #[test]
    fn an_empty_query_does_not_become_a_stray_parameter() {
        assert_eq!(safe_url(&url("https://example.com/p?")), "https://example.com/p?");
    }

    /// reqwest appends the failing URL to its own message, so the same masking has to reach there.
    #[test]
    fn the_url_a_transport_error_quotes_is_masked_too() {
        let failed = url("https://alice:hunter2@example.com/p?token=s3cret");
        let text = format!("error sending request for url ({failed})");

        let safe = safe_error_text(&text, Some(&failed));

        assert_eq!(
            safe,
            "error sending request for url (https://***@example.com/p?token=***)"
        );
        assert!(!safe.contains("hunter2") && !safe.contains("s3cret"));
    }

    #[test]
    fn an_error_without_a_url_is_left_alone() {
        assert_eq!(safe_error_text("builder error", None), "builder error");
    }
}
