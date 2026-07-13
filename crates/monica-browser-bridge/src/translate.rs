use std::path::PathBuf;

use claude_agent_sdk::types::{ClaudeAgentOptions, EffortLevel, Message};
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
- 出力の 1 文字目から JSONL を始める。挨拶・前置き・進行報告（「I'll translate...」\n\
  「翻訳を続けます」等）・後置き・コードフェンス・空行・説明を一切出力しない。\n\
- 入力と同じ順序・同じ件数で出力する。seg 番号を変えない。行を省略しない。\n\
- 訳文内の改行は \\n にエスケープする（1 レコード 1 行を守る）。\n\
- 固有名詞・用語の訳語はこの会話全体で一貫させる。\n\
- 翻訳しても意味がない seg は {\"seg\": <番号>, \"translation\": \"\"} と空文字列を返す。\n\
  該当するのは: リポジトリ名・パッケージ名・コマンド・ファイルパス・コード識別子・\n\
  URL・人名・組織名・数値やバージョンだけの行、および日本語圏でもそのまま英語表記で\n\
  使われる語（API、GitHub 等）だけで構成される行。\n\
- 文として意味を持つテキストは短くても翻訳する。迷ったら翻訳する。";

fn build_options() -> ClaudeAgentOptions {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    let cwd = PathBuf::from(&home).join("monica/browser");
    std::fs::create_dir_all(&cwd).ok();

    ClaudeAgentOptions::builder()
        .model("haiku")
        .cwd(cwd)
        .system_prompt(SYSTEM_PROMPT)
        // 翻訳に思考は不要。thinking が first token を数十秒遅らせる実測があった
        .max_thinking_tokens(0)
        .effort(EffortLevel::Low)
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
    let turn_start = std::time::Instant::now();
    let mut first_delta: Option<std::time::Duration> = None;
    let mut emitted = 0usize;
    let mut first_event_logged = false;
    let mut thinking_chars = 0usize;

    while let Some(message) = session.next().await {
        let message = match message {
            Ok(m) => m,
            Err(e) => {
                log::error!("stream error: {e}");
                return false;
            }
        };
        // 沈黙区間の内訳調査: 最初の stream event と thinking の量を観測する
        if let Message::StreamEvent { event, .. } = &message {
            if !first_event_logged {
                first_event_logged = true;
                log::info!(
                    "first stream event at {}ms: type={} delta_type={}",
                    turn_start.elapsed().as_millis(),
                    event["type"].as_str().unwrap_or("?"),
                    event["delta"]["type"].as_str().unwrap_or("-"),
                );
            }
            if event["delta"]["type"] == "thinking_delta" {
                thinking_chars += event["delta"]["thinking"].as_str().map_or(0, str::len);
            }
        }
        match message {
            Message::StreamEvent { event, .. }
                if event["type"] == "content_block_delta"
                    && event["delta"]["type"] == "text_delta" =>
            {
                if first_delta.is_none() {
                    first_delta = Some(turn_start.elapsed());
                    if thinking_chars > 0 {
                        log::info!(
                            "thinking before text: {thinking_chars} chars ({}ms until first text)",
                            turn_start.elapsed().as_millis(),
                        );
                    }
                }
                if let Some(text) = event["delta"]["text"].as_str() {
                    for st in line_buf.push_delta(text) {
                        // 空訳 = モデルが「翻訳不要」と判断した seg。挿入しない
                        if st.translation.trim().is_empty() {
                            continue;
                        }
                        emitted += 1;
                        if tx.send(st).await.is_err() {
                            return false;
                        }
                    }
                }
            }
            Message::Result(result) => {
                for st in line_buf.flush() {
                    if st.translation.trim().is_empty() {
                        continue;
                    }
                    emitted += 1;
                    let _ = tx.send(st).await;
                }
                log::info!(
                    "turn done: {emitted} seg emitted, first_token={}ms, total={}ms (api={}ms, turns={})",
                    first_delta.map_or(0, |d| d.as_millis()),
                    turn_start.elapsed().as_millis(),
                    result.duration_api_ms,
                    result.num_turns,
                );
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

    let total_chars: usize = segments.iter().map(|s| s.text.chars().count()).sum();

    // 最初のバッチだけ小さく切る: extension は viewport 内の seg を先頭に並べて
    // 送ってくるので、先頭バッチが速く返るほど画面が早く埋まる
    const FIRST_BATCH_CHAR_LIMIT: usize = 800;
    let mut head_len = 0;
    let mut head_chars = 0;
    for s in &segments {
        let c = s.text.chars().count();
        if head_len > 0 && head_chars + c > FIRST_BATCH_CHAR_LIMIT {
            break;
        }
        head_chars += c;
        head_len += 1;
    }
    let (head, rest) = segments.split_at(head_len);
    let mut batches: Vec<&[Segment]> = vec![head];
    batches.extend(batch::split_batches(rest, DEFAULT_CHAR_LIMIT));
    log::info!(
        "translate start: {} segments, {total_chars} chars, {} batches",
        segments.len(),
        batches.len(),
    );

    let first_prompt = format_batch(batches[0]);
    let options = build_options();

    let spawn_start = std::time::Instant::now();
    let mut session = query(&first_prompt, options)
        .await
        .map_err(|e| format!("failed to start claude: {e}"))?;
    log::info!(
        "claude session ready in {}ms (spawn + handshake + first prompt sent)",
        spawn_start.elapsed().as_millis(),
    );

    let total_start = std::time::Instant::now();

    log::info!("batch 1/{}: {} segs", batches.len(), batches[0].len());
    if !stream_turn(&mut session, &tx).await {
        return Err("first turn failed".into());
    }

    for (i, batch) in batches[1..].iter().enumerate() {
        log::info!("batch {}/{}: {} segs", i + 2, batches.len(), batch.len());
        let prompt = format_batch(batch);
        session
            .send_user_message(&prompt)
            .await
            .map_err(|e| format!("send error: {e}"))?;

        if !stream_turn(&mut session, &tx).await {
            return Err("turn failed".into());
        }
    }

    log::info!(
        "translate done: {} batches in {}ms",
        batches.len(),
        total_start.elapsed().as_millis(),
    );
    Ok(())
}
