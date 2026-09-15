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
            let fields = [("op", op.to_string()), ("error", e.to_string())];
            log::warn!(target: HTTP, "{}", render("http unsent", &fields));
            return Err(e);
        }
    };
    let mut fields = vec![
        ("op", op.to_string()),
        ("method", request.method().to_string()),
        ("url", redact(request.url().as_str()).into_owned()),
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
            fields.push(("error", redact(&e.to_string()).into_owned()));
            log::Level::Warn
        }
    };
    fields.push(("duration_ms", started.elapsed().as_millis().to_string()));
    log::log!(target: HTTP, level, "{}", render("http", &fields));
    result
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
