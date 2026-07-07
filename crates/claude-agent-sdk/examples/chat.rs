//! query() を使った対話型チャット。
//!
//! 実行: cargo run -p claude-agent-sdk --example chat [-- <cwd>]
//!   例: cargo run -p claude-agent-sdk --example chat -- ~/monica/personal
//! 環境変数: CHAT_MODEL でモデル指定（既定: haiku）
//! cwd 省略時は一時ディレクトリ（ファイルアクセスさせない）
//!
//! stream_event の text delta を逐次表示するので、token 粒度のストリーミングを
//! 体感できる。空行または "exit" で終了。

use claude_agent_sdk::callbacks::FnPermissionCallback;
use claude_agent_sdk::query;
use claude_agent_sdk::types::{
    ClaudeAgentOptions, Message, PermissionResult, PermissionResultAllow, PermissionResultDeny,
};
use futures_util::StreamExt;
use std::io::Write;
use std::sync::Arc;

fn shellexpand_tilde(path: &str) -> String {
    match (path.strip_prefix("~/"), std::env::var("HOME")) {
        (Some(rest), Ok(home)) => format!("{home}/{rest}"),
        _ => path.to_string(),
    }
}

fn read_user_line(prompt: &'static str) -> Option<String> {
    print!("{prompt}");
    std::io::stdout().flush().ok()?;
    let mut line = String::new();
    if std::io::stdin().read_line(&mut line).ok()? == 0 {
        return None; // EOF
    }
    let line = line.trim().to_string();
    if line.is_empty() || line == "exit" {
        None
    } else {
        Some(line)
    }
}

/// 1 ターン分のメッセージを描画する。result まで読んだら true を返す。
async fn render_turn(session: &mut claude_agent_sdk::Query) -> bool {
    while let Some(message) = session.next().await {
        let message = match message {
            Ok(message) => message,
            Err(error) => {
                eprintln!("\n[stream error] {error}");
                return false;
            }
        };
        match message {
            Message::StreamEvent { event, .. } => {
                if event["type"] == "content_block_delta" && event["delta"]["type"] == "text_delta"
                {
                    if let Some(text) = event["delta"]["text"].as_str() {
                        print!("{text}");
                        let _ = std::io::stdout().flush();
                    }
                }
            }
            Message::Result {
                duration_ms,
                num_turns,
                total_cost_usd,
                ..
            } => {
                let cost = total_cost_usd
                    .map(|c| format!(" cost=${c:.4}"))
                    .unwrap_or_default();
                println!("\n--- ({duration_ms}ms, turns={num_turns}{cost}) ---");
                return true;
            }
            _ => {}
        }
    }
    false
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let model = std::env::var("CHAT_MODEL").unwrap_or_else(|_| "haiku".into());
    let cwd = std::env::args()
        .nth(1)
        .map(|arg| std::path::PathBuf::from(shellexpand_tilde(&arg)))
        .filter(|path| {
            let ok = path.is_dir();
            if !ok {
                eprintln!("cwd not found: {} (falling back to temp dir)", path.display());
            }
            ok
        })
        .unwrap_or_else(std::env::temp_dir);
    println!(
        "chat with {model} in {} (empty line or \"exit\" to quit)",
        cwd.display()
    );

    let Some(first) = tokio::task::spawn_blocking(|| read_user_line("you> "))
        .await
        .unwrap()
    else {
        return;
    };

    // sandbox 外のツール（WebFetch / WebSearch / 書き込み系 Bash 等）は can_use_tool が
    // 飛んでくる。ターミナルで y/N を聞いて allow / deny を返す
    let ask_permission = Arc::new(FnPermissionCallback::new(|tool_name, input, _context| {
        Box::pin(async move {
            let original_input = input.clone();
            let summary = serde_json::to_string(&input).unwrap_or_default();
            let summary = if summary.chars().count() > 200 {
                let truncated: String = summary.chars().take(200).collect();
                format!("{truncated}...")
            } else {
                summary
            };
            let allowed = tokio::task::spawn_blocking(move || {
                print!("\n[permission] {tool_name} {summary}\nallow? [y/N] ");
                let _ = std::io::stdout().flush();
                let mut line = String::new();
                std::io::stdin().read_line(&mut line).unwrap_or(0);
                matches!(line.trim(), "y" | "Y" | "yes")
            })
            .await
            .unwrap_or(false);
            Ok(if allowed {
                // allow は updatedInput に元の input を返す（CLI はこれで実行を続行する）
                PermissionResult::Allow(PermissionResultAllow {
                    updated_input: Some(original_input),
                    ..PermissionResultAllow::default()
                })
            } else {
                PermissionResult::Deny(PermissionResultDeny {
                    message: "denied by user".into(),
                    interrupt: false,
                })
            })
        })
    }));

    let options = ClaudeAgentOptions::builder()
        .cwd(cwd)
        .model(model)
        .can_use_tool(ask_permission)
        .build();
    let mut session = query(&first, options).await.expect("failed to start claude");

    loop {
        if !render_turn(&mut session).await {
            eprintln!("session ended");
            return;
        }
        let Some(line) = tokio::task::spawn_blocking(|| read_user_line("you> "))
            .await
            .unwrap()
        else {
            return;
        };
        if let Err(error) = session.send_user_message(&line).await {
            eprintln!("[send error] {error}");
            return;
        }
    }
}
