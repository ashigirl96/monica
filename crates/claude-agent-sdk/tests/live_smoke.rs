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

/// 入力側の drift 検知: 送った user message が CLI に受理されたかは手元では
/// 検証できないため、`--replay-user-messages` の echo back と突き合わせる。
/// 送信内容と replay の text が一致し、replay に uuid が付与されていれば、
/// 入力スキーマが最新 CLI に通じている。
#[tokio::test(flavor = "current_thread")]
#[ignore = "requires local claude login; consumes one small haiku turn"]
async fn sent_user_message_is_accepted_and_replayed() {
    let options = ClaudeAgentOptions::builder()
        .cwd(std::env::temp_dir())
        .model("haiku")
        .build();
    let mut transport = SubprocessTransport::spawn(&options).expect("spawn failed");

    let sent_text = "Reply with exactly: ok";
    let user_message = serde_json::json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": [{ "type": "text", "text": sent_text }],
        },
    });
    transport
        .write_line(&user_message.to_string())
        .await
        .expect("write user message");

    let mut replayed: Option<serde_json::Value> = None;
    let mut got_result = false;
    tokio::time::timeout(Duration::from_secs(120), async {
        while let Some(line) = transport.next_line().await {
            let value: serde_json::Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            match value.get("type").and_then(|t| t.as_str()) {
                Some("user") => replayed = Some(value),
                Some("result") => {
                    got_result = true;
                    break;
                }
                _ => {}
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out; stderr: {:?}", transport.stderr_tail()));

    assert!(got_result, "result message not received");
    let replayed = replayed.expect("user message was not replayed (--replay-user-messages broken?)");
    let replayed_text = replayed
        .pointer("/message/content/0/text")
        .and_then(|t| t.as_str());
    assert_eq!(
        replayed_text,
        Some(sent_text),
        "replayed content differs from sent input: {replayed}"
    );
    assert!(
        replayed.get("uuid").and_then(|u| u.as_str()).is_some(),
        "replay lacks uuid (rewind/fork 前提が壊れている): {replayed}"
    );

    transport.kill().await.expect("kill");
}
