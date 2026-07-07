//! 実セッションの生イベントを fixtures として採取する。
//! raw_events hook（journal 用 hook）の使用例を兼ねる。
//!
//! 実行: cargo run -p claude-agent-sdk --example capture_fixtures
//! 出力: crates/claude-agent-sdk/tests/fixtures/basic_turn.jsonl
//!
//! haiku で 1 ターンだけ実行するため僅かにトークンを消費する（subscription 枠）。

use claude_agent_sdk::transport::SubprocessTransport;
use claude_agent_sdk::types::{ClaudeAgentOptions, RawEventDirection};
use std::io::Write;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// wire コーパス（生 wire 行の蓄積場所）。tests/wire_drift.rs が読む。
/// プロンプト本文を含むためコミットせずローカルにのみ置く。
fn corpus_path() -> std::path::PathBuf {
    let dir = std::env::var_os("CLAUDE_AGENT_SDK_CORPUS")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::path::PathBuf::from(std::env::var_os("HOME").unwrap())
                .join(".monica/claude-agent-sdk/wire-corpus")
        });
    std::fs::create_dir_all(&dir).unwrap();
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    dir.join(format!("capture-{stamp}.jsonl"))
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let out_path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/basic_turn.jsonl"
    );
    std::fs::create_dir_all(std::path::Path::new(out_path).parent().unwrap()).unwrap();
    let corpus = corpus_path();
    let file = Arc::new(Mutex::new((
        std::fs::File::create(out_path).unwrap(),
        std::fs::File::create(&corpus).unwrap(),
    )));

    let journal = Arc::clone(&file);
    let options = ClaudeAgentOptions::builder()
        .cwd(std::env::temp_dir())
        .model("haiku")
        .raw_events(Arc::new(move |direction: RawEventDirection, line: &str| {
            let entry = serde_json::json!({
                "dir": direction,
                "line": serde_json::from_str::<serde_json::Value>(line)
                    .unwrap_or_else(|_| serde_json::Value::String(line.to_string())),
            });
            let mut files = journal.lock().unwrap();
            writeln!(files.0, "{entry}").unwrap();
            writeln!(files.1, "{entry}").unwrap();
        }))
        .build();

    let mut transport = SubprocessTransport::spawn(&options).expect("spawn failed");

    let initialize = serde_json::json!({
        "type": "control_request",
        "request_id": "capture-init-1",
        "request": { "subtype": "initialize" },
    });
    transport
        .write_line(&initialize.to_string())
        .await
        .unwrap();

    let user_message = serde_json::json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": [{ "type": "text", "text": "Reply with exactly: ok" }],
        },
    });
    transport.write_line(&user_message.to_string()).await.unwrap();

    let done = tokio::time::timeout(Duration::from_secs(120), async {
        while let Some(line) = transport.next_line().await {
            let value: serde_json::Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if value.get("type").and_then(|t| t.as_str()) == Some("result") {
                return true;
            }
        }
        false
    })
    .await
    .unwrap_or(false);

    transport.kill().await.ok();
    assert!(done, "result message not received; see {out_path}");
    let lines = std::fs::read_to_string(out_path).unwrap().lines().count();
    println!("captured {lines} raw events -> {out_path}");
    println!("corpus appended -> {}", corpus.display());
}
