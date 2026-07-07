//! 実プロセスを使う smoke test。トークン消費とログイン状態に依存するため
//! CI では走らせず、ローカルで `cargo test -p claude-agent-sdk -- --ignored` で実行する。

use claude_agent_sdk::transport::SubprocessTransport;
use claude_agent_sdk::types::ClaudeAgentOptions;
use std::time::Duration;

/// Phase 1 完了条件: `-p` なし spawn → init 応答の受信。
///
/// initialize control_request を送り、control_response（commands / models / account を含む）
/// が返ることを確認する。`--permission-prompt-tool stdio` + `-p` なしは --help 上
/// サポート外の組み合わせなので、CLI 更新で壊れたらこのテストが検知する。
#[tokio::test(flavor = "current_thread")]
#[ignore = "requires local claude login; consumes no tokens but spawns a real process"]
async fn spawn_without_print_and_receive_init_response() {
    let options = ClaudeAgentOptions::builder()
        .cwd(std::env::temp_dir())
        .build();
    let mut transport = SubprocessTransport::spawn(&options).expect("spawn failed");

    let initialize = serde_json::json!({
        "type": "control_request",
        "request_id": "smoke-init-1",
        "request": { "subtype": "initialize" },
    });
    transport
        .write_line(&initialize.to_string())
        .await
        .expect("write initialize");

    let response = tokio::time::timeout(Duration::from_secs(60), async {
        while let Some(line) = transport.next_line().await {
            let value: serde_json::Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let ty = value.get("type").and_then(|t| t.as_str());
            if ty == Some("control_response") {
                return Some(value);
            }
        }
        None
    })
    .await
    .unwrap_or_else(|_| panic!("no control_response within 60s; stderr: {:?}", transport.stderr_tail()))
    .expect("stdout closed before control_response");

    let subtype = response
        .pointer("/response/subtype")
        .and_then(|s| s.as_str());
    assert_eq!(
        subtype,
        Some("success"),
        "unexpected initialize response: {response}"
    );

    transport.kill().await.expect("kill");
}
