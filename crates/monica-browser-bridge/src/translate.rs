use std::collections::HashSet;
use std::path::PathBuf;

use claude_agent_sdk::types::{ClaudeAgentOptions, EffortLevel, Message, ToolsConfig};
use claude_agent_sdk::{Query, query};
use futures_util::StreamExt;
use tokio::sync::mpsc;

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
        // ツールを一切持たせない。can_use_tool 未設定の default deny と合わせて
        // 「呼べない + 呼べても拒否」の二重防御
        .tools(ToolsConfig::from_list(vec![]))
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

async fn stream_turn(
    session: &mut Query,
    tx: &mpsc::Sender<SegTranslation>,
    answered: &mut HashSet<u64>,
) -> bool {
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
                        answered.insert(st.seg);
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
                    answered.insert(st.seg);
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
    log::info!(
        "translate start: {} segments, {total_chars} chars",
        segments.len(),
    );

    // 全 seg を 1 turn で送る。streaming なので訳は行単位で即 push され、
    // 出力上限で末尾が欠けても answered との差分で正確に検出できる。
    // 欠けた seg（打ち切り・パース失敗・モデルの取りこぼし）だけを
    // 同一セッションの follow-up turn で再送する
    const MAX_RETRIES: usize = 2;

    let options = build_options();
    let spawn_start = std::time::Instant::now();
    let mut session = query(&format_batch(&segments), options)
        .await
        .map_err(|e| format!("failed to start claude: {e}"))?;
    log::info!(
        "claude session ready in {}ms (spawn + handshake + first prompt sent)",
        spawn_start.elapsed().as_millis(),
    );

    let total_start = std::time::Instant::now();
    let mut answered: HashSet<u64> = HashSet::new();

    if !stream_turn(&mut session, &tx, &mut answered).await {
        return Err("first turn failed".into());
    }

    let mut remaining: Vec<Segment> = segments;
    remaining.retain(|s| !answered.contains(&s.seg));

    for attempt in 1..=MAX_RETRIES {
        if remaining.is_empty() {
            break;
        }
        log::warn!(
            "retry {attempt}/{MAX_RETRIES}: {} segs unanswered",
            remaining.len(),
        );
        session
            .send_user_message(&format_batch(&remaining))
            .await
            .map_err(|e| format!("send error: {e}"))?;

        if !stream_turn(&mut session, &tx, &mut answered).await {
            return Err("retry turn failed".into());
        }
        remaining.retain(|s| !answered.contains(&s.seg));
    }

    if !remaining.is_empty() {
        log::error!("{} segs still untranslated after retries", remaining.len());
    }

    log::info!(
        "translate done: {}/{} segs answered in {}ms",
        answered.len(),
        answered.len() + remaining.len(),
        total_start.elapsed().as_millis(),
    );
    Ok(())
}
