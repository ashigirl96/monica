use std::collections::HashSet;
use std::path::PathBuf;

use claude_agent_sdk::types::{ClaudeAgentOptions, EffortLevel, Message, ToolsConfig};
use claude_agent_sdk::{ClaudeError, Query, query};
use futures_util::{Stream, StreamExt};
use monica_settings::{TranslateEffort, TranslateModel};
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

/// 翻訳ループが claude セッションに要求する最小 interface。
/// fake を注入して欠落リトライを claude 非依存でテストするための縫い目。
pub trait TranslateSession: Stream<Item = Result<Message, ClaudeError>> + Unpin + Send {
    fn send_user_message(
        &mut self,
        text: &str,
    ) -> impl std::future::Future<Output = Result<(), ClaudeError>> + Send;
}

impl TranslateSession for Query {
    async fn send_user_message(&mut self, text: &str) -> Result<(), ClaudeError> {
        Query::send_user_message(self, text).await
    }
}

fn model_arg(model: TranslateModel) -> &'static str {
    match model {
        TranslateModel::Haiku => "haiku",
        TranslateModel::Sonnet => "sonnet",
        TranslateModel::Opus => "opus",
    }
}

fn effort_arg(effort: TranslateEffort) -> EffortLevel {
    match effort {
        TranslateEffort::Low => EffortLevel::Low,
        TranslateEffort::Medium => EffortLevel::Medium,
        TranslateEffort::High => EffortLevel::High,
    }
}

fn build_options(model: TranslateModel, effort: TranslateEffort) -> ClaudeAgentOptions {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    let cwd = PathBuf::from(&home).join("monica/browser");
    std::fs::create_dir_all(&cwd).ok();

    ClaudeAgentOptions::builder()
        .model(model_arg(model))
        .cwd(cwd)
        .system_prompt(SYSTEM_PROMPT)
        // 翻訳に思考は不要。thinking が first token を数十秒遅らせる実測があった
        .max_thinking_tokens(0)
        .effort(effort_arg(effort))
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

async fn stream_turn<S: TranslateSession>(
    session: &mut S,
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
                if result.is_error {
                    log::error!(
                        "turn failed: subtype={} ({} seg emitted before failure)",
                        result.subtype,
                        emitted,
                    );
                    return false;
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
    model: TranslateModel,
    effort: TranslateEffort,
) -> Result<(), String> {
    if segments.is_empty() {
        return Ok(());
    }

    let total_chars: usize = segments.iter().map(|s| s.text.chars().count()).sum();
    log::info!(
        "translate start: {} segments, {total_chars} chars",
        segments.len(),
    );

    let options = build_options(model, effort);
    let spawn_start = std::time::Instant::now();
    let mut session = query(&format_batch(&segments), options)
        .await
        .map_err(|e| format!("failed to start claude: {e}"))?;
    log::info!(
        "claude session ready in {}ms (spawn + handshake + first prompt sent)",
        spawn_start.elapsed().as_millis(),
    );

    translate_with(&mut session, segments, tx, MAX_RETRIES).await
}

// 全 seg を 1 turn で送る。streaming なので訳は行単位で即 push され、
// 出力上限で末尾が欠けても answered との差分で正確に検出できる。
// 欠けた seg（打ち切り・パース失敗・モデルの取りこぼし）だけを
// 同一セッションの follow-up turn で再送する
const MAX_RETRIES: usize = 2;

/// 最初のプロンプトは送信済み（`query()` が送る）前提で、turn の受信と
/// 欠落 seg の follow-up 再送だけを担う。
async fn translate_with<S: TranslateSession>(
    session: &mut S,
    segments: Vec<Segment>,
    tx: mpsc::Sender<SegTranslation>,
    max_retries: usize,
) -> Result<(), String> {
    let total_start = std::time::Instant::now();
    let mut answered: HashSet<u64> = HashSet::new();

    if !stream_turn(session, &tx, &mut answered).await {
        return Err("first turn failed".into());
    }

    let mut remaining: Vec<Segment> = segments;
    remaining.retain(|s| !answered.contains(&s.seg));

    for attempt in 1..=max_retries {
        if remaining.is_empty() {
            break;
        }
        log::warn!(
            "retry {attempt}/{max_retries}: {} segs unanswered",
            remaining.len(),
        );
        session
            .send_user_message(&format_batch(&remaining))
            .await
            .map_err(|e| format!("send error: {e}"))?;

        if !stream_turn(session, &tx, &mut answered).await {
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

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::pin::Pin;
    use std::task::{Context, Poll};

    use claude_agent_sdk::types::SessionId;

    use super::*;

    /// スクリプト済みの turn 列を流す fake。send_user_message ごとに次の turn へ進む。
    struct FakeSession {
        current: VecDeque<Result<Message, ClaudeError>>,
        turns: VecDeque<Vec<Result<Message, ClaudeError>>>,
        sent: Vec<String>,
    }

    impl FakeSession {
        fn new(mut turns: Vec<Vec<Result<Message, ClaudeError>>>) -> Self {
            let first = if turns.is_empty() {
                Vec::new()
            } else {
                turns.remove(0)
            };
            Self {
                current: first.into(),
                turns: turns.into(),
                sent: Vec::new(),
            }
        }
    }

    impl Stream for FakeSession {
        type Item = Result<Message, ClaudeError>;

        fn poll_next(
            mut self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Option<Self::Item>> {
            Poll::Ready(self.current.pop_front())
        }
    }

    impl TranslateSession for FakeSession {
        async fn send_user_message(&mut self, text: &str) -> Result<(), ClaudeError> {
            self.sent.push(text.to_string());
            self.current = self.turns.pop_front().unwrap_or_default().into();
            Ok(())
        }
    }

    fn delta(text: &str) -> Result<Message, ClaudeError> {
        Ok(Message::StreamEvent {
            uuid: "test".to_string(),
            session_id: SessionId::new("test"),
            event: serde_json::json!({
                "type": "content_block_delta",
                "delta": { "type": "text_delta", "text": text },
            }),
            parent_tool_use_id: None,
        })
    }

    fn turn_result(is_error: bool) -> Result<Message, ClaudeError> {
        Ok(serde_json::from_value(serde_json::json!({
            "type": "result",
            "subtype": if is_error { "error_during_execution" } else { "success" },
            "duration_ms": 0,
            "duration_api_ms": 0,
            "is_error": is_error,
            "num_turns": 1,
            "session_id": "test",
        }))
        .unwrap())
    }

    fn segs(ids: &[u64]) -> Vec<Segment> {
        ids.iter()
            .map(|&seg| Segment {
                seg,
                text: format!("text {seg}"),
            })
            .collect()
    }

    fn translation_line(seg: u64) -> String {
        format!("{{\"seg\":{seg},\"translation\":\"訳{seg}\"}}\n")
    }

    async fn run(
        mut session: FakeSession,
        segments: Vec<Segment>,
    ) -> (Result<(), String>, Vec<SegTranslation>, Vec<String>) {
        let (tx, mut rx) = mpsc::channel(64);
        let result = translate_with(&mut session, segments, tx, MAX_RETRIES).await;
        let mut received = Vec::new();
        while let Ok(st) = rx.try_recv() {
            received.push(st);
        }
        (result, received, session.sent)
    }

    #[tokio::test]
    async fn first_turn_answers_everything_no_retry() {
        let session = FakeSession::new(vec![vec![
            delta(&translation_line(1)),
            delta(&translation_line(2)),
            turn_result(false),
        ]]);
        let (result, received, sent) = run(session, segs(&[1, 2])).await;
        assert!(result.is_ok());
        assert_eq!(
            received.iter().map(|st| st.seg).collect::<Vec<_>>(),
            vec![1, 2]
        );
        assert!(sent.is_empty(), "no follow-up expected: {sent:?}");
    }

    #[tokio::test]
    async fn missing_seg_is_resent_alone() {
        let session = FakeSession::new(vec![
            vec![delta(&translation_line(1)), turn_result(false)],
            vec![delta(&translation_line(2)), turn_result(false)],
        ]);
        let (result, received, sent) = run(session, segs(&[1, 2])).await;
        assert!(result.is_ok());
        assert_eq!(
            received.iter().map(|st| st.seg).collect::<Vec<_>>(),
            vec![1, 2]
        );
        assert_eq!(sent.len(), 1);
        assert!(sent[0].contains("\"seg\":2"), "follow-up: {}", sent[0]);
        assert!(
            !sent[0].contains("\"seg\":1"),
            "answered seg must not be resent: {}",
            sent[0]
        );
    }

    #[tokio::test]
    async fn gives_up_after_max_retries() {
        // どの turn も seg 2 に答えない → MAX_RETRIES 回だけ再送して打ち切り
        let session = FakeSession::new(vec![
            vec![delta(&translation_line(1)), turn_result(false)],
            vec![turn_result(false)],
            vec![turn_result(false)],
        ]);
        let (result, received, sent) = run(session, segs(&[1, 2])).await;
        assert!(result.is_ok(), "exhausted retries is not a hard error");
        assert_eq!(received.iter().map(|st| st.seg).collect::<Vec<_>>(), vec![1]);
        assert_eq!(sent.len(), MAX_RETRIES);
    }

    #[tokio::test]
    async fn empty_translation_counts_as_answered_but_not_emitted() {
        let session = FakeSession::new(vec![vec![
            delta("{\"seg\":1,\"translation\":\"\"}\n"),
            delta(&translation_line(2)),
            turn_result(false),
        ]]);
        let (result, received, sent) = run(session, segs(&[1, 2])).await;
        assert!(result.is_ok());
        assert_eq!(received.iter().map(|st| st.seg).collect::<Vec<_>>(), vec![2]);
        assert!(sent.is_empty(), "empty translation must not trigger retry");
    }

    #[tokio::test]
    async fn stream_error_fails_the_request() {
        let session = FakeSession::new(vec![vec![
            delta(&translation_line(1)),
            Err(ClaudeError::Connection("boom".to_string())),
        ]]);
        let (result, _received, _sent) = run(session, segs(&[1, 2])).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn error_result_fails_the_request() {
        let session = FakeSession::new(vec![vec![turn_result(true)]]);
        let (result, _received, _sent) = run(session, segs(&[1])).await;
        assert!(result.is_err());
    }
}
