use std::path::PathBuf;

use claude_agent_sdk::types::{ClaudeAgentOptions, Message};
use claude_agent_sdk::{Query, query};
use futures_util::StreamExt;
use tokio::sync::mpsc;

use crate::batch::{self, DEFAULT_CHAR_LIMIT};
use crate::jsonl::LineBuffer;
use crate::protocol::{SegTranslation, Segment};

const SYSTEM_PROMPT: &str = "\
あなたは翻訳エンジンです。ユーザーは {\"seg\": <番号>, \"text\": \"<原文>\"} の JSON を\n\
1 行 1 件で送ります。各行を自然な日本語に翻訳し、\n\
{\"seg\": <同じ番号>, \"translation\": \"<日本語訳>\"} を JSONL で 1 行ずつ出力してください。\n\
規則:\n\
- 出力は JSONL のみ。前置き・後置き・コードフェンス・空行・説明を一切出力しない。\n\
- 入力と同じ順序・同じ件数で出力する。seg 番号を変えない。\n\
- 訳文内の改行は \\n にエスケープする（1 レコード 1 行を守る）。\n\
- 固有名詞・用語の訳語はこの会話全体で一貫させる。";

fn build_options() -> ClaudeAgentOptions {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    let cwd = PathBuf::from(&home).join("monica/browser");
    std::fs::create_dir_all(&cwd).ok();

    ClaudeAgentOptions::builder()
        .model("haiku")
        .cwd(cwd)
        .system_prompt(SYSTEM_PROMPT)
        .build()
}

fn format_batch(batch: &[Segment]) -> String {
    batch
        .iter()
        .map(|s| {
            serde_json::to_string(&serde_json::json!({"seg": s.seg, "text": s.text}))
                .unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

async fn stream_turn(session: &mut Query, tx: &mpsc::Sender<SegTranslation>) -> bool {
    let mut line_buf = LineBuffer::new();

    while let Some(message) = session.next().await {
        let message = match message {
            Ok(m) => m,
            Err(e) => {
                log::error!("stream error: {e}");
                return false;
            }
        };
        match message {
            Message::StreamEvent { event, .. }
                if event["type"] == "content_block_delta"
                    && event["delta"]["type"] == "text_delta" =>
            {
                if let Some(text) = event["delta"]["text"].as_str() {
                    for st in line_buf.push_delta(text) {
                        if tx.send(st).await.is_err() {
                            return false;
                        }
                    }
                }
            }
            Message::Result(_) => {
                for st in line_buf.flush() {
                    let _ = tx.send(st).await;
                }
                return true;
            }
            _ => {}
        }
    }
    false
}

pub async fn translate(
    segments: Vec<Segment>,
    tx: mpsc::Sender<SegTranslation>,
) -> Result<(), String> {
    if segments.is_empty() {
        return Ok(());
    }

    let batches = batch::split_batches(&segments, DEFAULT_CHAR_LIMIT);

    let first_prompt = format_batch(batches[0]);
    let options = build_options();

    let mut session = query(&first_prompt, options)
        .await
        .map_err(|e| format!("failed to start claude: {e}"))?;

    if !stream_turn(&mut session, &tx).await {
        return Err("first turn failed".into());
    }

    for batch in &batches[1..] {
        let prompt = format_batch(batch);
        session
            .send_user_message(&prompt)
            .await
            .map_err(|e| format!("send error: {e}"))?;

        if !stream_turn(&mut session, &tx).await {
            return Err("turn failed".into());
        }
    }

    Ok(())
}
