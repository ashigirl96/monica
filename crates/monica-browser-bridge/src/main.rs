use std::net::SocketAddr;

const DEFAULT_PORT: u16 = 43110;

#[tokio::main(flavor = "current_thread")]
async fn main() {
    env_logger::init();

    let port: u16 = std::env::var("TRANSLATE_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_PORT);

    let allowed_origins: Vec<String> = std::env::var("TRANSLATE_ALLOWED_ORIGINS")
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    if allowed_origins.is_empty() {
        eprintln!("warning: TRANSLATE_ALLOWED_ORIGINS is empty — all WS connections will be rejected");
    }

    let addr = SocketAddr::from(([127, 0, 0, 1], port));

    if let Err(e) = monica_browser_bridge::server::run_server(addr, allowed_origins).await {
        eprintln!("server error: {e}");
        std::process::exit(1);
    }
}
