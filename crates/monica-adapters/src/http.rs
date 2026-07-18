use std::sync::Once;
use std::time::Duration;

pub(crate) fn http_client(timeout: Duration) -> reqwest::Client {
    install_crypto_provider();
    reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

// reqwest is built with `rustls-no-provider`, so the single rustls instance has
// no default CryptoProvider and would panic on first TLS use. Install ring to
// match octocrab's `rustls-ring`; ignore the error if another caller won the race.
fn install_crypto_provider() {
    static INIT: Once = Once::new();
    INIT.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}
