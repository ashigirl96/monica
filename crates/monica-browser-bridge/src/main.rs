use std::net::SocketAddr;
use std::path::PathBuf;

#[tokio::main(flavor = "current_thread")]
async fn main() {
    // desktop が stdio を <base>/logs/browser-bridge.log にリダイレクトして spawn する。
    // default の error だと translate/server の log::info! が全部落ちる
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let base = match parse_monica_home() {
        Ok(Some(path)) => path,
        Ok(None) => match monica_paths::base_dir() {
            Ok(path) => path,
            Err(e) => {
                log::error!("failed to resolve base dir: {e}");
                std::process::exit(1);
            }
        },
        Err(e) => {
            log::error!("{e}");
            std::process::exit(1);
        }
    };

    let settings = match monica_settings::Settings::load_from(&base) {
        Ok(s) => s.translate,
        Err(e) => {
            log::error!("failed to load settings from {}: {e:#}", base.display());
            std::process::exit(1);
        }
    };

    if let Err(e) = settings.validate() {
        log::error!("invalid translate settings: {e}");
        std::process::exit(1);
    }

    if !settings.enabled {
        // desktop は enabled=false なら spawn しない。ここに来るのは手動起動だけ
        log::info!("translate is disabled in settings; exiting");
        return;
    }

    if settings.allowed_origins.is_empty() {
        log::warn!("allowed_origins is empty — all WS connections will be rejected");
    }

    let addr = SocketAddr::from(([127, 0, 0, 1], settings.port));

    if let Err(e) = monica_browser_bridge::server::run_server(addr, settings).await {
        log::error!("server error: {e}");
        std::process::exit(1);
    }
}

fn parse_monica_home() -> Result<Option<PathBuf>, String> {
    let mut base = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--monica-home" => {
                let path = args.next().ok_or("--monica-home requires a path")?;
                base = Some(PathBuf::from(path));
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    Ok(base)
}
