//! ローカルに蓄積した生 wire コーパスに対する drift 検知テスト。
//!
//! コーパスは examples/capture_fixtures.rs の実行（将来的には Monica の raw_events
//! journal）で ~/.claude-agent-sdk/wire-corpus/ に蓄積される。transcript と違い
//! wire フォーマットそのものなので、封筒フィールド含め完全一致で検証できる。
//! プロンプト本文を含むためコーパスはコミットしない。環境依存のため
//! `cargo test -p claude-agent-sdk -- --ignored` でローカル実行のみ。

mod common;

use claude_agent_sdk::parser::parse_line;
use common::{record, Drift, DriftStats};
use std::path::PathBuf;

fn corpus_dir() -> PathBuf {
    std::env::var_os("CLAUDE_AGENT_SDK_CORPUS")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("HOME").expect("HOME not set"))
                .join(".monica/claude-agent-sdk/wire-corpus")
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

    let mut stats = DriftStats::default();
    let mut failures: Vec<String> = Vec::new();

    for path in &files {
        for entry in std::fs::read_to_string(path).expect("read corpus").lines() {
            let entry: serde_json::Value = serde_json::from_str(entry).expect("corpus entry");
            if entry["dir"] != "received" {
                continue;
            }
            let line = entry["line"].to_string();
            match record(
                parse_line(&line),
                &["user", "assistant", "result", "stream_event", "system"],
                &mut stats,
            ) {
                Drift::Malformed(error) => {
                    failures.push(format!("Malformed in {}: {error}", path.display()));
                }
                Drift::TypedDecodeFailure { ty, error } => {
                    failures.push(format!("typed decode failed for {ty}: {error}"));
                }
                Drift::None => {}
            }
        }
    }

    println!(
        "wire corpus: {} files, breakdown: {:?}",
        files.len(),
        stats.totals
    );
    println!("unknown type distribution: {:?}", stats.unknown_types);

    assert!(
        stats.totals.get("message").copied().unwrap_or(0) > 0,
        "no typed Message parsed from wire corpus"
    );
    assert!(failures.is_empty(), "wire drift detected:\n{}", failures.join("\n"));
}
