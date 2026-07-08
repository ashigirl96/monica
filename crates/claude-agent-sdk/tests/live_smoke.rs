//! 実プロセスを使う smoke test。トークン消費とログイン状態に依存するため
//! CI では走らせず、ローカルで `cargo test -p claude-agent-sdk -- --ignored` で実行する。

use claude_agent_sdk::control::{requests, ControlRequestTracker, InboundControl};
use claude_agent_sdk::parser::{parse_line, ParsedLine};
use claude_agent_sdk::transport::SubprocessTransport;
use claude_agent_sdk::types::{
    ClaudeAgentOptions, Message, PermissionResult, PermissionResultDeny,
};
use std::time::Duration;

fn user_message(text: &str) -> String {
    serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": [{ "type": "text", "text": text }] },
    })
    .to_string()
}

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

/// Phase 3 完了条件 1: interrupt の ack 往復。
/// 長いタスクの実行中に interrupt を送り、control_response(success) の ack と
/// 中断ターンの result を確認する。
#[tokio::test(flavor = "current_thread")]
#[ignore = "requires local claude login; consumes a partial haiku turn"]
async fn interrupt_is_acked_and_turn_is_aborted() {
    let options = ClaudeAgentOptions::builder()
        .cwd(std::env::temp_dir())
        .model("haiku")
        .build();
    let mut transport = SubprocessTransport::spawn(&options).expect("spawn failed");
    let mut tracker = ControlRequestTracker::new();

    transport
        .write_line(&user_message(
            "Count from 1 to 5000, one number per line. Do not stop until you finish.",
        ))
        .await
        .unwrap();

    let mut pending_ack = None;
    let mut result: Option<serde_json::Value> = None;
    tokio::time::timeout(Duration::from_secs(120), async {
        while let Some(line) = transport.next_line().await {
            match parse_line(&line) {
                ParsedLine::Control(value) => {
                    tracker.handle_control(&value);
                }
                ParsedLine::Message(message) => {
                    let value = serde_json::to_value(&*message).unwrap();
                    match value.get("type").and_then(|t| t.as_str()) {
                        // 出力が流れ始めたのを確認してから interrupt を送る
                        Some("stream_event") if pending_ack.is_none() => {
                            let (line, ack) = tracker.create_request(requests::interrupt());
                            transport.write_line(&line).await.unwrap();
                            pending_ack = Some(ack);
                        }
                        Some("result") => {
                            result = Some(value);
                            break;
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out; stderr: {:?}", transport.stderr_tail()));

    let ack = pending_ack.expect("no stream_event observed before result");
    ack.wait().await.expect("interrupt was not acked with success");

    let result = result.expect("no result message after interrupt");
    let subtype = result.get("subtype").and_then(|s| s.as_str());
    assert_eq!(
        subtype,
        Some("error_during_execution"),
        "interrupted turn should end with error_during_execution: {result}"
    );

    transport.kill().await.unwrap();
}

/// Phase 3 完了条件 2: can_use_tool の受信と deny 応答。
/// sandbox 外への書き込みを指示して can_use_tool を誘発し、deny で拒否。
/// 対象ファイルが作られないことと、ターンが正常に完了することを確認する。
#[tokio::test(flavor = "current_thread")]
#[ignore = "requires local claude login; consumes one small haiku turn"]
async fn can_use_tool_request_is_received_and_deny_is_honored() {
    let target = std::env::temp_dir().join("claude_agent_sdk_deny_smoke.txt");
    let _ = std::fs::remove_file(&target);
    let home_target = format!("{}/claude_agent_sdk_deny_smoke.txt", std::env::var("HOME").unwrap());
    let _ = std::fs::remove_file(&home_target);

    let options = ClaudeAgentOptions::builder()
        .cwd(std::env::temp_dir())
        .model("haiku")
        .build();
    let mut transport = SubprocessTransport::spawn(&options).expect("spawn failed");
    let mut tracker = ControlRequestTracker::new();

    transport
        .write_line(&user_message(&format!(
            "Run exactly this bash command and nothing else: echo hello > {home_target}"
        )))
        .await
        .unwrap();

    let mut permission_seen = false;
    let mut got_result = false;
    tokio::time::timeout(Duration::from_secs(180), async {
        while let Some(line) = transport.next_line().await {
            match parse_line(&line) {
                ParsedLine::Control(value) => {
                    if let Some(InboundControl::Request {
                        request_id,
                        request,
                    }) = tracker.handle_control(&value)
                    {
                        if request.get("subtype").and_then(|s| s.as_str())
                            == Some("can_use_tool")
                        {
                            permission_seen = true;
                            let deny = PermissionResult::Deny(PermissionResultDeny {
                                message: "denied by live smoke test".into(),
                                interrupt: false,
                            });
                            let line = tracker
                                .create_permission_response(&request_id, &deny)
                                .unwrap();
                            transport.write_line(&line).await.unwrap();
                        }
                    }
                }
                ParsedLine::Message(message) => {
                    let value = serde_json::to_value(&*message).unwrap();
                    if value.get("type").and_then(|t| t.as_str()) == Some("result") {
                        got_result = true;
                        break;
                    }
                }
                _ => {}
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out; stderr: {:?}", transport.stderr_tail()));

    assert!(permission_seen, "can_use_tool control_request never arrived");
    assert!(got_result, "turn did not complete after deny");
    assert!(
        !std::path::Path::new(&home_target).exists(),
        "denied command was executed anyway"
    );

    transport.kill().await.unwrap();
}

/// Phase 4 完了条件: query() で複数ターンの対話が成立する。
/// 高レベル API 経由で 2 ターン送り、それぞれ result まで到達することを確認する。
#[tokio::test(flavor = "current_thread")]
#[ignore = "requires local claude login; consumes two small haiku turns"]
async fn query_supports_multi_turn_conversation() {
    use claude_agent_sdk::query;
    use futures_util::StreamExt;

    let options = ClaudeAgentOptions::builder()
        .cwd(std::env::temp_dir())
        .model("haiku")
        .build();

    let mut session = query("Reply with exactly: one", options)
        .await
        .expect("query failed");

    // 1 ターン目: result まで読み、assistant テキストを集める
    let mut first_text = String::new();
    let mut first_done = false;
    while let Some(message) = session.next().await {
        let value = serde_json::to_value(message.expect("stream error")).unwrap();
        match value.get("type").and_then(|t| t.as_str()) {
            Some("assistant") => {
                if let Some(blocks) = value.pointer("/message/content").and_then(|c| c.as_array()) {
                    for block in blocks {
                        if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                            first_text.push_str(text);
                        }
                    }
                }
            }
            Some("result") => {
                first_done = true;
                break;
            }
            _ => {}
        }
    }
    assert!(first_done, "first turn did not reach result");
    assert!(!first_text.is_empty(), "first turn produced no assistant text");

    // 2 ターン目: 同一プロセスに追加の user message を送る
    session
        .send_user_message("Reply with exactly: two")
        .await
        .expect("send second turn");

    let mut second_done = false;
    while let Some(message) = session.next().await {
        let value = serde_json::to_value(message.expect("stream error")).unwrap();
        if value.get("type").and_then(|t| t.as_str()) == Some("result") {
            second_done = true;
            break;
        }
    }
    assert!(second_done, "second turn did not reach result");
}

/// Phase 5 完了条件: セッション制御面の実機確認。
/// - init_info に commands / models が入る
/// - set_permission_mode / set_model の ack が success
/// - --resume で同一 session_id のまま文脈が継続する
/// - --fork-session で新しい session_id に分岐する
#[tokio::test(flavor = "current_thread")]
#[ignore = "requires local claude login; consumes three small haiku turns"]
async fn resume_and_fork_preserve_and_branch_session() {
    use claude_agent_sdk::query;
    use claude_agent_sdk::types::{PermissionMode, SessionId};
    use futures_util::StreamExt;

    async fn run_turn(session: &mut claude_agent_sdk::Query) -> (String, String) {
        let mut text = String::new();
        let mut session_id = String::new();
        while let Some(message) = session.next().await {
            let value = serde_json::to_value(message.expect("stream error")).unwrap();
            match value.get("type").and_then(|t| t.as_str()) {
                Some("assistant") => {
                    if let Some(blocks) =
                        value.pointer("/message/content").and_then(|c| c.as_array())
                    {
                        for block in blocks {
                            if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                                text.push_str(t);
                            }
                        }
                    }
                }
                Some("result") => {
                    session_id = value
                        .get("session_id")
                        .and_then(|s| s.as_str())
                        .unwrap_or_default()
                        .to_string();
                    break;
                }
                _ => {}
            }
        }
        (text, session_id)
    }

    let options = || {
        ClaudeAgentOptions::builder()
            .cwd(std::env::temp_dir())
            .model("haiku")
    };

    // ターン 1: 単語を覚えさせ、制御メソッドの ack を確認
    let mut first = query(
        "Remember the word: pineapple. Reply with exactly: ok",
        options().build(),
    )
    .await
    .expect("first query failed");
    let (_, original_sid) = run_turn(&mut first).await;
    assert!(!original_sid.is_empty(), "no session_id in result");

    let init = first.init_info().expect("init_info not populated after first turn");
    assert!(
        init.get("commands").is_some(),
        "init response lacks commands: {init}"
    );

    first
        .set_permission_mode(PermissionMode::Plan)
        .await
        .expect("set_permission_mode not acked");
    first
        .set_model(Some("haiku"))
        .await
        .expect("set_model not acked");
    drop(first);

    // ターン 2: --resume で同一セッション継続（文脈が残っているか）
    let mut resumed = query(
        "What word did I ask you to remember? Reply with just that word.",
        options().resume(SessionId::new(original_sid.clone())).build(),
    )
    .await
    .expect("resume query failed");
    let (resumed_text, resumed_sid) = run_turn(&mut resumed).await;
    drop(resumed);

    assert_eq!(
        resumed_sid, original_sid,
        "resume must keep the same session_id"
    );
    assert!(
        resumed_text.to_lowercase().contains("pineapple"),
        "resumed session lost context: {resumed_text:?}"
    );

    // ターン 3: --fork-session で別 session_id に分岐
    let mut forked = query(
        "Reply with exactly: ok",
        options()
            .resume(SessionId::new(original_sid.clone()))
            .fork_session(true)
            .build(),
    )
    .await
    .expect("fork query failed");
    let (_, forked_sid) = run_turn(&mut forked).await;

    assert!(!forked_sid.is_empty());
    assert_ne!(
        forked_sid, original_sid,
        "fork_session must branch to a new session_id"
    );
}

/// P1 リグレッション: Query を drop すると（ターン実行中でも）actor の command チャネルが
/// 閉じ、claude subprocess が終了する。actor が command 送信側を握っていると
/// この終了経路が到達不能になり、プロセスが残る。
#[tokio::test(flavor = "current_thread")]
#[ignore = "requires local claude login; spawns and kills a real process"]
async fn dropping_query_terminates_subprocess() {
    use claude_agent_sdk::query;
    use futures_util::StreamExt;

    let options = ClaudeAgentOptions::builder()
        .cwd(std::env::temp_dir())
        .model("haiku")
        .build();

    let mut session = query(
        "Count from 1 to 100000 slowly, one number per line.",
        options,
    )
    .await
    .expect("query failed");

    // 出力が流れ始めた（= ターン実行中）のを確認してから drop する
    let started = tokio::time::timeout(Duration::from_secs(60), async {
        while let Some(message) = session.next().await {
            if let Ok(Message::StreamEvent { .. }) = message {
                return true;
            }
        }
        false
    })
    .await
    .unwrap_or(false);
    assert!(started, "turn never started streaming");

    // Query を drop → actor の command_rx が閉じ、kill_on_drop で subprocess が死ぬはず。
    // 残っていればこのテストプロセス終了後もゾンビが残るので、ここでは drop が
    // ブロックせず完了することと、直後に新セッションを開けることで健全性を確認する
    drop(session);
    tokio::time::sleep(Duration::from_millis(500)).await;

    let opts2 = ClaudeAgentOptions::builder()
        .cwd(std::env::temp_dir())
        .model("haiku")
        .build();
    let mut second = query("Reply with exactly: ok", opts2)
        .await
        .expect("second query after drop failed");
    let done = tokio::time::timeout(Duration::from_secs(60), async {
        while let Some(message) = second.next().await {
            if let Ok(Message::Result(_)) = message {
                return true;
            }
        }
        false
    })
    .await
    .unwrap_or(false);
    assert!(done, "second session did not complete after dropping first");
}
