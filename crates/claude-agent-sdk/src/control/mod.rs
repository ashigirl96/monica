//! control protocol の状態管理（ControlRequestTracker）。
//!
//! transport には依存せず、「送る行の生成」と「受けた JSON の解釈」だけを行う。
//! I/O・ルーティングは呼び出し側（query / client 層）の責務。
//!
//! tracker は方向別に非対称:
//! - outbound（host → CLI、interrupt 等の ack 待ち）: 30 秒タイムアウト。
//!   プロセス exit 時は `reject_all` で全 pending を即エラーにする
//! - inbound（CLI → host、can_use_tool 等の人間の応答待ち）: タイムアウトなし。
//!   `control_cancel_request` が来たときだけ取り下げる

use std::collections::HashMap;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::oneshot;

use crate::error::{ClaudeError, Result};
use crate::types::PermissionResult;

/// outbound control_request の ack 待ちタイムアウト
pub const OUTBOUND_ACK_TIMEOUT: Duration = Duration::from_secs(30);

/// CLI から届いた control 行の解釈結果
#[derive(Debug)]
pub enum InboundControl {
    /// CLI からの要求（can_use_tool / hook_callback / 未知 subtype も含めそのまま forward）
    Request {
        /// 応答時に control_response へ入れる ID
        request_id: String,
        /// `request` フィールドの中身（subtype を含む生 JSON）
        request: Value,
    },
    /// CLI が過去の要求を取り下げた（未応答ダイアログを閉じるべき）
    Cancelled {
        /// 取り下げられた要求の ID
        request_id: String,
    },
}

/// outbound の ack を待つハンドル
pub struct PendingAck {
    request_id: String,
    subtype: String,
    rx: oneshot::Receiver<std::result::Result<Value, String>>,
}

impl PendingAck {
    /// 応答した request の ID
    #[must_use]
    pub fn request_id(&self) -> &str {
        &self.request_id
    }

    /// ack（control_response）を 30 秒タイムアウト付きで待つ
    pub async fn wait(self) -> Result<Value> {
        match tokio::time::timeout(OUTBOUND_ACK_TIMEOUT, self.rx).await {
            Ok(Ok(Ok(response))) => Ok(response),
            Ok(Ok(Err(error))) => Err(ClaudeError::control_protocol(format!(
                "{} failed: {error}",
                self.subtype
            ))),
            Ok(Err(_)) => Err(ClaudeError::control_protocol(format!(
                "{} pending dropped (process exited?)",
                self.subtype
            ))),
            Err(_) => Err(ClaudeError::control_timeout(
                OUTBOUND_ACK_TIMEOUT.as_secs(),
                self.subtype,
            )),
        }
    }
}

/// control_request / control_response の対応関係を管理する tracker
#[derive(Default)]
pub struct ControlRequestTracker {
    next_id: u64,
    outbound: HashMap<String, (String, oneshot::Sender<std::result::Result<Value, String>>)>,
    inbound: HashMap<String, Value>,
}

impl ControlRequestTracker {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// outbound control_request の行と ack 待ちハンドルを作る。
    /// 返った行をそのまま transport に書き、ハンドルで ack を待つ。
    pub fn create_request(&mut self, request: Value) -> (String, PendingAck) {
        self.next_id += 1;
        let request_id = format!("req_{}", self.next_id);
        let subtype = request
            .get("subtype")
            .and_then(Value::as_str)
            .unwrap_or("<unknown>")
            .to_string();
        let (tx, rx) = oneshot::channel();
        self.outbound
            .insert(request_id.clone(), (subtype.clone(), tx));
        let line = json!({
            "type": "control_request",
            "request_id": request_id,
            "request": request,
        })
        .to_string();
        (
            line,
            PendingAck {
                request_id,
                subtype,
                rx,
            },
        )
    }

    /// parser が `ParsedLine::Control` に分類した行を渡す。
    /// outbound の ack はここで解決され、CLI からの要求だけが `Some` で返る。
    pub fn handle_control(&mut self, value: &Value) -> Option<InboundControl> {
        match value.get("type").and_then(Value::as_str) {
            Some("control_response") => {
                let response = value.get("response")?;
                let request_id = response.get("request_id").and_then(Value::as_str)?;
                if let Some((_, tx)) = self.outbound.remove(request_id) {
                    let outcome = match response.get("subtype").and_then(Value::as_str) {
                        Some("success") => {
                            Ok(response.get("response").cloned().unwrap_or(Value::Null))
                        }
                        _ => Err(response
                            .get("error")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown control error")
                            .to_string()),
                    };
                    let _ = tx.send(outcome);
                }
                None
            }
            Some("control_request") => {
                let request_id = value.get("request_id").and_then(Value::as_str)?.to_string();
                let request = value.get("request").cloned().unwrap_or(Value::Null);
                self.inbound.insert(request_id.clone(), request.clone());
                Some(InboundControl::Request {
                    request_id,
                    request,
                })
            }
            Some("control_cancel_request") => {
                let request_id = value.get("request_id").and_then(Value::as_str)?.to_string();
                self.inbound.remove(&request_id);
                Some(InboundControl::Cancelled { request_id })
            }
            _ => None,
        }
    }

    /// inbound 要求への成功応答の行を作る（作成後 pending から外れる）
    pub fn create_success_response(&mut self, request_id: &str, response: Value) -> String {
        self.inbound.remove(request_id);
        json!({
            "type": "control_response",
            "response": {
                "subtype": "success",
                "request_id": request_id,
                "response": response,
            },
        })
        .to_string()
    }

    /// inbound 要求へのエラー応答の行を作る
    pub fn create_error_response(&mut self, request_id: &str, error: &str) -> String {
        self.inbound.remove(request_id);
        json!({
            "type": "control_response",
            "response": {
                "subtype": "error",
                "request_id": request_id,
                "error": error,
            },
        })
        .to_string()
    }

    /// can_use_tool への応答行を作る
    pub fn create_permission_response(
        &mut self,
        request_id: &str,
        result: &PermissionResult,
    ) -> Result<String> {
        let response = serde_json::to_value(result)?;
        Ok(self.create_success_response(request_id, response))
    }

    /// 応答待ちのままの inbound 要求（再接続時の未応答ダイアログ復元に使う）
    #[must_use]
    pub fn pending_inbound(&self) -> Vec<(&str, &Value)> {
        self.inbound
            .iter()
            .map(|(id, request)| (id.as_str(), request))
            .collect()
    }

    /// プロセス exit 時に呼ぶ。outbound の全 pending を即エラーで解決する
    pub fn reject_all(&mut self, reason: &str) {
        for (_, (_, tx)) in self.outbound.drain() {
            let _ = tx.send(Err(reason.to_string()));
        }
    }
}

/// 既知の outbound control_request のペイロード
pub mod requests {
    use serde_json::{json, Value};

    use crate::types::PermissionMode;

    #[must_use]
    pub fn initialize() -> Value {
        json!({ "subtype": "initialize" })
    }

    #[must_use]
    pub fn interrupt() -> Value {
        json!({ "subtype": "interrupt" })
    }

    #[must_use]
    pub fn set_model(model: Option<&str>) -> Value {
        json!({ "subtype": "set_model", "model": model })
    }

    #[must_use]
    pub fn set_permission_mode(mode: PermissionMode) -> Value {
        json!({ "subtype": "set_permission_mode", "mode": mode })
    }

    #[must_use]
    pub fn set_max_thinking_tokens(tokens: Option<u32>) -> Value {
        json!({ "subtype": "set_max_thinking_tokens", "max_thinking_tokens": tokens })
    }

    #[must_use]
    pub fn rewind_files(user_message_id: &str, dry_run: bool) -> Value {
        json!({ "subtype": "rewind_files", "user_message_id": user_message_id, "dry_run": dry_run })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{PermissionResultAllow, PermissionResultDeny};

    fn parse(line: &str) -> Value {
        serde_json::from_str(line).unwrap()
    }

    #[test]
    fn create_request_wraps_payload_in_envelope_with_unique_ids() {
        let mut tracker = ControlRequestTracker::new();
        let (line1, ack1) = tracker.create_request(requests::interrupt());
        let (line2, ack2) = tracker.create_request(requests::interrupt());

        let value = parse(&line1);
        assert_eq!(value["type"], "control_request");
        assert_eq!(value["request"]["subtype"], "interrupt");
        assert_ne!(ack1.request_id(), ack2.request_id());
        assert_eq!(parse(&line2)["request_id"], ack2.request_id());
    }

    #[tokio::test]
    async fn success_response_resolves_pending_ack() {
        let mut tracker = ControlRequestTracker::new();
        let (_, ack) = tracker.create_request(requests::interrupt());
        let response = json!({
            "type": "control_response",
            "response": {
                "subtype": "success",
                "request_id": ack.request_id(),
                "response": { "ok": true },
            },
        });
        assert!(tracker.handle_control(&response).is_none());
        assert_eq!(ack.wait().await.unwrap(), json!({ "ok": true }));
    }

    #[tokio::test]
    async fn error_response_resolves_pending_ack_as_error() {
        let mut tracker = ControlRequestTracker::new();
        let (_, ack) = tracker.create_request(requests::set_model(Some("haiku")));
        let response = json!({
            "type": "control_response",
            "response": {
                "subtype": "error",
                "request_id": ack.request_id(),
                "error": "model not available",
            },
        });
        tracker.handle_control(&response);
        let error = ack.wait().await.unwrap_err();
        assert!(error.to_string().contains("model not available"));
    }

    #[tokio::test]
    async fn reject_all_fails_every_pending_ack() {
        let mut tracker = ControlRequestTracker::new();
        let (_, ack1) = tracker.create_request(requests::interrupt());
        let (_, ack2) = tracker.create_request(requests::initialize());
        tracker.reject_all("process exited");
        assert!(ack1.wait().await.unwrap_err().to_string().contains("process exited"));
        assert!(ack2.wait().await.unwrap_err().to_string().contains("process exited"));
    }

    #[test]
    fn unknown_response_id_is_ignored() {
        let mut tracker = ControlRequestTracker::new();
        let response = json!({
            "type": "control_response",
            "response": { "subtype": "success", "request_id": "req_999", "response": null },
        });
        assert!(tracker.handle_control(&response).is_none());
    }

    #[test]
    fn inbound_request_is_forwarded_even_with_unknown_subtype() {
        let mut tracker = ControlRequestTracker::new();
        let request = json!({
            "type": "control_request",
            "request_id": "cli_1",
            "request": { "subtype": "brand_new_control", "payload": 1 },
        });
        match tracker.handle_control(&request) {
            Some(InboundControl::Request {
                request_id,
                request,
            }) => {
                assert_eq!(request_id, "cli_1");
                assert_eq!(request["subtype"], "brand_new_control");
            }
            other => panic!("expected Request, got {other:?}"),
        }
        assert_eq!(tracker.pending_inbound().len(), 1);
    }

    #[test]
    fn cancel_removes_pending_inbound() {
        let mut tracker = ControlRequestTracker::new();
        tracker.handle_control(&json!({
            "type": "control_request",
            "request_id": "cli_1",
            "request": { "subtype": "can_use_tool" },
        }));
        let cancelled = tracker.handle_control(&json!({
            "type": "control_cancel_request",
            "request_id": "cli_1",
        }));
        assert!(matches!(cancelled, Some(InboundControl::Cancelled { .. })));
        assert!(tracker.pending_inbound().is_empty());
    }

    #[test]
    fn permission_responses_match_wire_format() {
        let mut tracker = ControlRequestTracker::new();

        let allow = PermissionResult::Allow(PermissionResultAllow {
            updated_input: Some(json!({ "command": "ls" })),
            updated_permissions: None,
            user_feedback: None,
        });
        let line = tracker.create_permission_response("cli_1", &allow).unwrap();
        let value = parse(&line);
        assert_eq!(value["response"]["response"]["behavior"], "allow");
        assert_eq!(
            value["response"]["response"]["updatedInput"]["command"],
            "ls"
        );

        let deny = PermissionResult::Deny(PermissionResultDeny {
            message: "not allowed".into(),
            interrupt: true,
        });
        let line = tracker.create_permission_response("cli_2", &deny).unwrap();
        let value = parse(&line);
        assert_eq!(value["response"]["response"]["behavior"], "deny");
        assert_eq!(value["response"]["response"]["interrupt"], true);

        let line = tracker.create_success_response("cli_3", json!({ "continue": true }));
        let value = parse(&line);
        assert_eq!(value["response"]["response"]["continue"], true);
    }
}
