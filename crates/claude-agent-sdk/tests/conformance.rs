//! 実セッションから採取した fixtures（tests/fixtures/*.jsonl）に対する conformance test。
//! 採取方法は examples/capture_fixtures.rs を参照。トークンを消費せず CI で走る。

use claude_agent_sdk::parser::{parse_line, ParsedLine};
use claude_agent_sdk::types::Message;

fn fixture_lines() -> Vec<(String, String)> {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/basic_turn.jsonl"
    );
    std::fs::read_to_string(path)
        .expect("fixture missing; run: cargo run -p claude-agent-sdk --example capture_fixtures")
        .lines()
        .map(|entry| {
            let entry: serde_json::Value = serde_json::from_str(entry).unwrap();
            (
                entry["dir"].as_str().unwrap().to_string(),
                entry["line"].to_string(),
            )
        })
        .collect()
}

#[test]
fn every_fixture_line_is_classified_without_loss() {
    for (dir, line) in fixture_lines() {
        match parse_line(&line) {
            ParsedLine::Malformed { raw, error } => {
                panic!("fixture line misclassified as Malformed ({dir}): {error}\n{raw}")
            }
            ParsedLine::Empty => panic!("fixture line misclassified as Empty ({dir}): {line}"),
            _ => {}
        }
    }
}

#[test]
fn known_message_types_parse_as_typed_messages() {
    let mut assistant = 0;
    let mut result = 0;
    let mut stream_event = 0;
    let mut system = 0;
    let mut user = 0;
    let mut control = 0;

    for (_, line) in fixture_lines() {
        match parse_line(&line) {
            ParsedLine::Message(message) => match *message {
                Message::Assistant { .. } => assistant += 1,
                Message::Result(_) => result += 1,
                Message::StreamEvent { .. } => stream_event += 1,
                Message::System { .. } => system += 1,
                Message::User { .. } => user += 1,
            },
            ParsedLine::Control(_) => control += 1,
            _ => {}
        }
    }

    assert!(assistant >= 1, "no assistant message parsed");
    assert!(result >= 1, "no result message parsed");
    assert!(stream_event >= 1, "no stream_event parsed (token 粒度 delta)");
    assert!(system >= 1, "no system message parsed");
    assert!(user >= 1, "no user message parsed (--replay-user-messages)");
    assert!(control >= 2, "control_request/response not routed to Control");
}

/// Message enum 未対応の type（例: rate_limit_event）が Unknown として
/// 生の値ごと保持されること。variant を追加したらこのテストの期待値を更新する。
#[test]
fn uncovered_types_are_preserved_as_unknown() {
    let unknowns: Vec<String> = fixture_lines()
        .iter()
        .filter(|(dir, _)| dir == "received")
        .filter_map(|(_, line)| match parse_line(line) {
            ParsedLine::Unknown { value, .. } => Some(
                value
                    .get("type")
                    .and_then(|t| t.as_str())
                    .unwrap_or("<no type>")
                    .to_string(),
            ),
            _ => None,
        })
        .collect();

    assert!(
        unknowns.contains(&"rate_limit_event".to_string()),
        "rate_limit_event should fall through to Unknown, got: {unknowns:?}"
    );
    for ty in &unknowns {
        assert_ne!(ty, "<no type>", "Unknown event lost its type field");
    }
}
