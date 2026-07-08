//! TS Agent SDK の `query()` に相当する高レベル API。
//!
//! transport（I/O）・parser（分類）・ControlRequestTracker（control 状態）を 1 本の
//! actor タスクで束ねる。actor が transport を単独所有し、`Query` は
//! - assistant/result/stream_event 等の `Message` を `Stream` として受け取り
//! - `interrupt()` / `set_model()` / `set_permission_mode()` を control コマンドとして送る
//! - `can_use_tool` を裏で callback にルーティングして応答する
//!
//! という TS SDK 互換の形を提供する。

use std::pin::Pin;
use std::task::{Context, Poll};

use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};

use crate::control::{requests, ControlRequestTracker, InboundControl};
use crate::error::{ClaudeError, Result};
use crate::parser::{parse_line, ParsedLine};
use crate::transport::SubprocessTransport;
use crate::types::{
    CanUseToolCallback, ClaudeAgentOptions, Message, PermissionMode, PermissionResult,
    PermissionResultDeny, PermissionUpdate, ToolPermissionContext,
};

/// `Query`（外部）から actor に送る制御コマンド。
/// このチャネルの sender は actor 内に保持しない。全 `Query` が drop されると
/// チャネルが閉じ、actor が transport を畳んで終了できる。
enum Command {
    /// user message を送る
    SendUserMessage(String),
    /// outbound control_request を送り、ack を待つ
    Control {
        request: Value,
        reply: oneshot::Sender<Result<Value>>,
    },
}

/// actor 内部で完結する permission 応答（can_use_tool callback の結果）。
/// 外部 Command とは別チャネルにすることで、callback 用 sender が
/// 外部 command チャネルの生存に影響しないようにする。
struct PermissionResponse {
    request_id: String,
    result: PermissionResult,
}

/// `query()` の返り値。`Message` の Stream + control メソッドを持つ。
pub struct Query {
    messages: mpsc::UnboundedReceiver<Result<Message>>,
    commands: mpsc::UnboundedSender<Command>,
    init_info: std::sync::Arc<std::sync::OnceLock<Value>>,
}

impl Query {
    /// 現在のターンを中断する（interrupt control_request の ack を待つ）
    pub async fn interrupt(&self) -> Result<()> {
        self.control(requests::interrupt()).await.map(|_| ())
    }

    /// モデルを切り替える
    pub async fn set_model(&self, model: Option<&str>) -> Result<()> {
        self.control(requests::set_model(model)).await.map(|_| ())
    }

    /// permission mode を切り替える
    pub async fn set_permission_mode(&self, mode: PermissionMode) -> Result<()> {
        self.control(requests::set_permission_mode(mode))
            .await
            .map(|_| ())
    }

    /// thinking token 上限を切り替える
    pub async fn set_max_thinking_tokens(&self, tokens: Option<u32>) -> Result<()> {
        self.control(requests::set_max_thinking_tokens(tokens))
            .await
            .map(|_| ())
    }

    /// initialize 応答（commands / models / account 等）。ack 受信前は None。
    #[must_use]
    pub fn init_info(&self) -> Option<Value> {
        self.init_info.get().cloned()
    }

    /// streaming input mode で追加の user message を送る
    pub async fn send_user_message(&self, text: &str) -> Result<()> {
        let line = json!({
            "type": "user",
            "message": { "role": "user", "content": [{ "type": "text", "text": text }] },
        })
        .to_string();
        self.commands
            .send(Command::SendUserMessage(line))
            .map_err(|_| ClaudeError::not_connected())
    }

    async fn control(&self, request: Value) -> Result<Value> {
        let (reply, rx) = oneshot::channel();
        self.commands
            .send(Command::Control { request, reply })
            .map_err(|_| ClaudeError::not_connected())?;
        rx.await.map_err(|_| ClaudeError::not_connected())?
    }
}

impl futures_core::Stream for Query {
    type Item = Result<Message>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.messages.poll_recv(cx)
    }
}

/// prompt を送って対話を開始する（one-shot 相当。streaming input は `Query::send_user_message`）。
///
/// spawn → initialize handshake → prompt 送信までを行い、`Query` を返す。
pub async fn query(prompt: &str, options: ClaudeAgentOptions) -> Result<Query> {
    let can_use_tool = options.can_use_tool.clone();
    let mut transport = SubprocessTransport::spawn(&options)?;
    let mut tracker = ControlRequestTracker::new();

    // initialize handshake（init 応答の受信は smoke check を兼ねる）
    let (init_line, init_ack) = tracker.create_request(requests::initialize());
    transport.write_line(&init_line).await?;

    let (message_tx, message_rx) = mpsc::unbounded_channel();
    let (command_tx, command_rx) = mpsc::unbounded_channel();

    // 最初の prompt を送る
    let first = json!({
        "type": "user",
        "message": { "role": "user", "content": [{ "type": "text", "text": prompt }] },
    })
    .to_string();
    command_tx
        .send(Command::SendUserMessage(first))
        .map_err(|_| ClaudeError::not_connected())?;

    let init_info = std::sync::Arc::new(std::sync::OnceLock::new());
    let (perm_tx, perm_rx) = mpsc::unbounded_channel();
    let actor = QueryActor {
        transport,
        tracker,
        can_use_tool,
        message_tx,
        command_rx,
        perm_tx,
        perm_rx,
    };
    tokio::spawn(actor.run(init_ack, std::sync::Arc::clone(&init_info)));

    Ok(Query {
        messages: message_rx,
        commands: command_tx,
        init_info,
    })
}

struct QueryActor {
    transport: SubprocessTransport,
    tracker: ControlRequestTracker,
    can_use_tool: Option<CanUseToolCallback>,
    message_tx: mpsc::UnboundedSender<Result<Message>>,
    command_rx: mpsc::UnboundedReceiver<Command>,
    perm_tx: mpsc::UnboundedSender<PermissionResponse>,
    perm_rx: mpsc::UnboundedReceiver<PermissionResponse>,
}

impl QueryActor {
    async fn run(
        mut self,
        init_ack: crate::control::PendingAck,
        init_info: std::sync::Arc<std::sync::OnceLock<Value>>,
    ) {
        // init の ack を解決するのはこの下の reader ループなので、ここで await すると
        // デッドロックする。ack 待ちは別タスクへ逃がし、失敗だけをストリームに流す。
        let init_error_tx = self.message_tx.clone();
        tokio::spawn(async move {
            match init_ack.wait().await {
                Ok(response) => {
                    let _ = init_info.set(response);
                }
                Err(error) => {
                    let _ = init_error_tx.send(Err(error));
                }
            }
        });

        loop {
            tokio::select! {
                command = self.command_rx.recv() => {
                    match command {
                        Some(Command::SendUserMessage(line)) => {
                            if let Err(error) = self.transport.write_line(&line).await {
                                let _ = self.message_tx.send(Err(error));
                            }
                        }
                        Some(Command::Control { request, reply }) => {
                            let (line, ack) = self.tracker.create_request(request);
                            if let Err(error) = self.transport.write_line(&line).await {
                                let _ = reply.send(Err(error));
                                continue;
                            }
                            // ack の解決は reader ループの handle_control が行うので、
                            // 待機だけ別タスクへ逃がしてループを塞がない
                            tokio::spawn(async move {
                                let _ = reply.send(ack.wait().await);
                            });
                        }
                        None => {
                            // 全 Query が drop された。transport を畳んで終了
                            let _ = self.transport.kill().await;
                            break;
                        }
                    }
                }
                Some(PermissionResponse { request_id, result }) = self.perm_rx.recv() => {
                    match self.tracker.create_permission_response(&request_id, &result) {
                        Ok(line) => {
                            if let Err(error) = self.transport.write_line(&line).await {
                                let _ = self.message_tx.send(Err(error));
                            }
                        }
                        Err(error) => {
                            let _ = self.message_tx.send(Err(error));
                        }
                    }
                }
                line = self.transport.next_line() => {
                    match line {
                        Some(line) => self.handle_line(&line),
                        None => {
                            // stdout が尽きた = プロセス終了。pending ack を全て畳む
                            self.tracker.reject_all("claude process exited");
                            break;
                        }
                    }
                }
            }
        }
    }

    fn handle_line(&mut self, line: &str) {
        match parse_line(line) {
            ParsedLine::Message(message) => {
                let _ = self.message_tx.send(Ok(*message));
            }
            ParsedLine::Control(value) => {
                if let Some(InboundControl::Request {
                    request_id,
                    request,
                }) = self.tracker.handle_control(&value)
                {
                    self.route_inbound_request(&request_id, &request);
                }
            }
            // Unknown / Malformed / Empty は Message ストリームには載せない。
            // 生イベントの観測は transport の raw_events hook が担う
            _ => {}
        }
    }

    /// CLI からの control_request（can_use_tool 等）を処理する
    fn route_inbound_request(&mut self, request_id: &str, request: &Value) {
        let subtype = request.get("subtype").and_then(Value::as_str);
        if subtype == Some("can_use_tool") {
            self.route_can_use_tool(request_id, request);
        }
        // その他の inbound subtype（elicitation 等）は Phase 5 以降。
        // tracker には pending として残るので pending_inbound() で観測できる
    }

    fn route_can_use_tool(&mut self, request_id: &str, request: &Value) {
        let tool_name = request
            .get("tool_name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let input = request.get("input").cloned().unwrap_or(Value::Null);
        // CLI が付ける「今後も許可」提案。未知形は無視して空にする（落とさない）
        let suggestions = request
            .get("permission_suggestions")
            .and_then(|s| serde_json::from_value::<Vec<PermissionUpdate>>(s.clone()).ok())
            .unwrap_or_default();

        let request_id = request_id.to_string();
        let perm_tx = self.perm_tx.clone();

        let Some(callback) = self.can_use_tool.clone() else {
            // callback 未設定なら安全側に倒して deny（プロセスを止めない）
            let deny = PermissionResult::Deny(PermissionResultDeny {
                message: "no can_use_tool handler configured".into(),
                interrupt: false,
            });
            let _ = perm_tx.send(PermissionResponse {
                request_id,
                result: deny,
            });
            return;
        };

        // callback は async なので別タスクへ逃がし、reader ループを塞がない。
        // 結果は perm チャネルで actor に戻し、応答行は tracker が生成する
        let context = ToolPermissionContext::new(suggestions);
        tokio::spawn(async move {
            let result = callback
                .call(tool_name, input, context)
                .await
                .unwrap_or_else(|error| {
                    PermissionResult::Deny(PermissionResultDeny {
                        message: format!("permission callback error: {error}"),
                        interrupt: false,
                    })
                });
            let _ = perm_tx.send(PermissionResponse { request_id, result });
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::StreamExt;

    #[test]
    fn query_is_a_message_stream() {
        // 型レベルの確認: Query が Stream<Item = Result<Message>> であること
        fn assert_stream<S: futures_core::Stream<Item = Result<Message>>>() {}
        assert_stream::<Query>();
    }

    #[tokio::test]
    async fn control_returns_not_connected_when_actor_gone() {
        // actor（command 受信側）が閉じていれば control() は NotConnected を返す
        let (msg_tx, msg_rx) = mpsc::unbounded_channel::<Result<Message>>();
        let (command_tx, command_rx) = mpsc::unbounded_channel::<Command>();
        drop(command_rx);
        let mut query = Query {
            messages: msg_rx,
            commands: command_tx,
            init_info: std::sync::Arc::new(std::sync::OnceLock::new()),
        };
        let err = query.interrupt().await.unwrap_err();
        assert!(matches!(err, ClaudeError::NotConnected));

        // message 送信側を落とせば Stream は None で閉じる
        drop(msg_tx);
        assert!(query.next().await.is_none());
    }
}
