//! query() を使った対話型チャット。
//!
//! 実行: cargo run -p claude-agent-sdk --example chat
//! 環境変数: CHAT_MODEL でモデル指定（既定: haiku）
//!
//! stream_event の text delta を逐次表示するので、token 粒度のストリーミングを
//! 体感できる。空行または "exit" で終了。

use claude_agent_sdk::query;
use claude_agent_sdk::types::{ClaudeAgentOptions, Message};
use futures_util::StreamExt;
use std::io::Write;

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
    println!("chat with {model} (empty line or \"exit\" to quit)");

    let Some(first) = tokio::task::spawn_blocking(|| read_user_line("you> "))
        .await
        .unwrap()
    else {
        return;
    };

    let options = ClaudeAgentOptions::builder()
        .cwd(std::env::temp_dir())
        .model(model)
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
