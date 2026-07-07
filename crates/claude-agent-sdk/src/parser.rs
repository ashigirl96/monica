//! stdout の 1 行を分類する 2 段デコードパーサ。
//!
//! 「未知イベントを絶対に落とさない」を型で保証する: どんな入力でも必ずいずれかの
//! variant に分類され、パース失敗が例外やエラー return でストリームを止めることはない。
//! CLI の更新で新しいイベント type が増えても `Unknown` として上に流れる。

use serde_json::Value;

use crate::types::Message;

/// stdout 1 行の分類結果
#[derive(Debug, Clone)]
pub enum ParsedLine {
    /// 型付き Message にデコードできた行
    Message(Box<Message>),
    /// control protocol の行（control_request / control_response / control_cancel_request）。
    /// ルーティングは control 層の責務なので生の JSON のまま渡す
    Control(Value),
    /// JSON としては正しいが、既知の型にデコードできなかった行。
    /// 未知の type、または既知 type の予期しない形。生の値とデコードエラーを保持する
    Unknown {
        /// 行全体の生の JSON 値
        value: Value,
        /// 型付きデコードを試みた際のエラー（type が未知の場合も含む）
        error: String,
    },
    /// JSON として不正な行
    Malformed {
        /// 生の行
        raw: String,
        /// パースエラー
        error: String,
    },
    /// 空行・空白のみの行
    Empty,
}

const CONTROL_TYPES: &[&str] = &["control_request", "control_response", "control_cancel_request"];

/// 1 行を分類する。決してパニックせず、必ずいずれかの variant を返す。
#[must_use]
pub fn parse_line(line: &str) -> ParsedLine {
    if line.trim().is_empty() {
        return ParsedLine::Empty;
    }

    let value: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(error) => {
            return ParsedLine::Malformed {
                raw: line.to_string(),
                error: error.to_string(),
            };
        }
    };

    if let Some(ty) = value.get("type").and_then(Value::as_str) {
        if CONTROL_TYPES.contains(&ty) {
            return ParsedLine::Control(value);
        }
    }

    match serde_json::from_value::<Message>(value.clone()) {
        Ok(message) => ParsedLine::Message(Box::new(message)),
        Err(error) => ParsedLine::Unknown {
            value,
            error: error.to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assistant_message_parses_as_message() {
        let line = r#"{"type":"assistant","message":{"model":"claude-haiku-4-5","content":[{"type":"text","text":"hi"}]},"session_id":"s1"}"#;
        match parse_line(line) {
            ParsedLine::Message(message) => {
                assert!(matches!(*message, Message::Assistant { .. }));
            }
            other => panic!("expected Message, got {other:?}"),
        }
    }

    #[test]
    fn system_message_with_arbitrary_subtype_is_absorbed() {
        let line = r#"{"type":"system","subtype":"totally_new_subtype","some_field":42}"#;
        match parse_line(line) {
            ParsedLine::Message(message) => match *message {
                Message::System { subtype, data } => {
                    assert_eq!(subtype, "totally_new_subtype");
                    assert_eq!(data.get("some_field"), Some(&serde_json::json!(42)));
                }
                other => panic!("expected System, got {other:?}"),
            },
            other => panic!("expected Message, got {other:?}"),
        }
    }

    #[test]
    fn control_lines_are_routed_to_control() {
        for line in [
            r#"{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool"}}"#,
            r#"{"type":"control_response","response":{"subtype":"success","request_id":"r1"}}"#,
            r#"{"type":"control_cancel_request","request_id":"r1"}"#,
        ] {
            assert!(
                matches!(parse_line(line), ParsedLine::Control(_)),
                "expected Control for {line}"
            );
        }
    }

    #[test]
    fn unknown_type_is_preserved_not_dropped() {
        let line = r#"{"type":"brand_new_event","uuid":"u1","payload":{"a":1}}"#;
        match parse_line(line) {
            ParsedLine::Unknown { value, error } => {
                assert_eq!(value.get("type"), Some(&serde_json::json!("brand_new_event")));
                assert!(!error.is_empty());
            }
            other => panic!("expected Unknown, got {other:?}"),
        }
    }

    #[test]
    fn known_type_with_broken_shape_is_unknown_not_error() {
        // type=result だが必須フィールド欠落 → 捨てずに Unknown として保持
        let line = r#"{"type":"result","subtype":"success"}"#;
        match parse_line(line) {
            ParsedLine::Unknown { value, .. } => {
                assert_eq!(value.get("type"), Some(&serde_json::json!("result")));
            }
            other => panic!("expected Unknown, got {other:?}"),
        }
    }

    #[test]
    fn malformed_json_is_captured_with_raw() {
        match parse_line("not json at all {") {
            ParsedLine::Malformed { raw, error } => {
                assert_eq!(raw, "not json at all {");
                assert!(!error.is_empty());
            }
            other => panic!("expected Malformed, got {other:?}"),
        }
    }

    #[test]
    fn blank_lines_are_empty() {
        assert!(matches!(parse_line(""), ParsedLine::Empty));
        assert!(matches!(parse_line("   "), ParsedLine::Empty));
    }
}
