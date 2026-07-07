//! ローカルに蓄積した生 wire コーパスに対する drift 検知テスト。
//!
//! コーパスは examples/capture_fixtures.rs の実行（将来的には Monica の raw_events
//! journal）で ~/.claude-agent-sdk/wire-corpus/ に蓄積される。transcript と違い
//! wire フォーマットそのものなので、封筒フィールド含め完全一致で検証できる。
//! プロンプト本文を含むためコーパスはコミットしない。環境依存のため
//! `cargo test -p claude-agent-sdk -- --ignored` でローカル実行のみ。

use claude_agent_sdk::parser::{parse_line, ParsedLine};
use std::collections::BTreeMap;
use std::path::PathBuf;

fn corpus_dir() -> PathBuf {
    std::env::var_os("CLAUDE_AGENT_SDK_CORPUS")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("HOME").expect("HOME not set"))
                .join(".claude-agent-sdk/wire-corpus")
        })
}

#[test]
#[ignore = "reads local wire corpus; run capture_fixtures example first"]
fn accumulated_wire_corpus_parses_without_drift() {
    let dir = corpus_dir();
    let files: Vec<PathBuf> = std::fs::read_dir(&dir)
        .unwrap_or_else(|_| {
            panic!(
                "corpus not found at {}; run: cargo run -p claude-agent-sdk --example capture_fixtures",
                dir.display()
            )
        })
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "jsonl"))
        .collect();
    assert!(!files.is_empty(), "wire corpus is empty: {}", dir.display());

    let mut totals: BTreeMap<&'static str, usize> = BTreeMap::new();
    let mut unknown_types: BTreeMap<String, usize> = BTreeMap::new();
    let mut failures: Vec<String> = Vec::new();

    for path in &files {
        for entry in std::fs::read_to_string(path).expect("read corpus").lines() {
            let entry: serde_json::Value = serde_json::from_str(entry).expect("corpus entry");
            if entry["dir"] != "received" {
                continue;
            }
            let line = entry["line"].to_string();
            match parse_line(&line) {
                ParsedLine::Malformed { error, .. } => {
                    failures.push(format!("Malformed in {}: {error}", path.display()));
                }
                ParsedLine::Empty => *totals.entry("empty").or_default() += 1,
                ParsedLine::Message(_) => *totals.entry("message").or_default() += 1,
                ParsedLine::Control(_) => *totals.entry("control").or_default() += 1,
                ParsedLine::Unknown { value, error } => {
                    *totals.entry("unknown").or_default() += 1;
                    let ty = value
                        .get("type")
                        .and_then(|t| t.as_str())
                        .unwrap_or("<no type>")
                        .to_string();
                    if ["user", "assistant", "result", "stream_event", "system"]
                        .contains(&ty.as_str())
                    {
                        failures.push(format!("typed decode failed for {ty}: {error}"));
                    }
                    *unknown_types.entry(ty).or_default() += 1;
                }
            }
        }
    }

    println!("wire corpus: {} files, breakdown: {totals:?}", files.len());
    println!("unknown type distribution: {unknown_types:?}");

    assert!(
        totals.get("message").copied().unwrap_or(0) > 0,
        "no typed Message parsed from wire corpus"
    );
    assert!(failures.is_empty(), "wire drift detected:\n{}", failures.join("\n"));
}
