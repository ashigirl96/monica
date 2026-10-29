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
    let relay = RemoteServer::start(home.join("ptyd.sock"), sizes.clone())?;
    println!(
        "{}",
        serde_json::json!({"path":relay.path, "secret":relay.secret()})
    );
    std::io::stdout().flush()?;
    for line in std::io::stdin().lock().lines() {
        let op: RequestOp = serde_json::from_str(&line?)?;
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
