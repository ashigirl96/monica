use monica_terminal_client::{
    remote::{RemoteServer, Sizes},
    PtydClient,
};
use monica_terminal_protocol::RequestOp;
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::Arc;

fn main() -> anyhow::Result<()> {
    let home = PathBuf::from(std::env::args().nth(1).expect("isolated home"));
    let sizes = Arc::new(Sizes::default());
    let renderers = Arc::new(monica_terminal_client::renderer::Renderers::default());
    let relay = RemoteServer::start(home.join("ptyd.sock"), sizes.clone(), renderers.clone())?;
    println!(
        "{}",
        serde_json::json!({"path":relay.path, "secret":relay.secret()})
    );
    std::io::stdout().flush()?;
    for line in std::io::stdin().lock().lines() {
        let value: serde_json::Value = serde_json::from_str(&line?)?;
        if let Some(action) = value["rendererControl"].as_str() {
            let session = value["session"].as_str().unwrap_or("shared");
            let now = std::time::Instant::now();
            match action {
                "ready" => {
                    let generation = renderers.register(session);
                    renderers.parsed(session, generation, 0, now);
                    println!("{}", serde_json::json!({"generation":generation}));
                }
                "stall" => {
                    renderers.output(session, now - std::time::Duration::from_secs(6));
                    println!("{{}}");
                }
                "disconnect" => {
                    renderers.disconnect();
                    println!("{{}}");
                }
                _ => anyhow::bail!("unknown renderer control"),
            }
            std::io::stdout().flush()?;
            continue;
        }
        let op: RequestOp = serde_json::from_value(value)?;
        if let RequestOp::Resize {
            session_id,
            rows,
            cols,
        } = op
        {
            let client = PtydClient::connect(&home.join("ptyd.sock"), |_| {})?;
            sizes.resize(&client, session_id, rows, cols)?;
            client.close()?;
        }
    }
    Ok(())
}
