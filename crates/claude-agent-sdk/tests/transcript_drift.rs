//! ローカルの Claude Code transcript を drift 検知コーパスとして使うテスト。
//!
//! ~/.claude/projects/**/*.jsonl の最新 5 ファイルを全行 parse_line に通す。
//! transcript は stream-json の wire フォーマットとは別物（camelCase 封筒フィールド等）だが、
//! user / assistant 行の中身はほぼ同型なので、常に最新の CLI が吐いた実データで
//! パーサの頑健性と型 drift を確認できる。環境依存のため live smoke と同じく
//! `cargo test -p claude-agent-sdk -- --ignored` でローカル実行のみ。

mod common;

use claude_agent_sdk::parser::parse_line;
use common::{record, Drift, DriftStats};
use std::path::PathBuf;

fn latest_transcripts(count: usize) -> Vec<PathBuf> {
    let projects = dirs_home().join(".claude/projects");
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = walk_jsonl(&projects)
        .into_iter()
        .filter_map(|path| {
            let mtime = path.metadata().ok()?.modified().ok()?;
            Some((mtime, path))
        })
        .collect();
    files.sort_by_key(|(mtime, _)| std::cmp::Reverse(*mtime));
    files.into_iter().take(count).map(|(_, p)| p).collect()
}

fn dirs_home() -> PathBuf {
    PathBuf::from(std::env::var_os("HOME").expect("HOME not set"))
}

fn walk_jsonl(dir: &std::path::Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            out.extend(walk_jsonl(&path));
        } else if path.extension().is_some_and(|e| e == "jsonl") {
            out.push(path);
        }
    }
    out
}

#[test]
#[ignore = "reads local ~/.claude transcripts; environment-dependent"]
fn latest_local_transcripts_never_break_the_parser() {
    let transcripts = latest_transcripts(5);
    assert!(
        !transcripts.is_empty(),
        "no transcripts found under ~/.claude/projects"
    );

    let mut stats = DriftStats::default();
    let mut typed_failures: Vec<String> = Vec::new();

    for path in &transcripts {
        let content = std::fs::read_to_string(path).expect("read transcript");
        for line in content.lines() {
            match record(
                parse_line(line),
                &["user", "assistant", "result", "stream_event"],
                &mut stats,
            ) {
                Drift::Malformed(error) => {
                    panic!("Malformed line in {}: {error}", path.display())
                }
                Drift::TypedDecodeFailure { ty, error } => {
                    typed_failures.push(format!("{ty}: {error}"));
                }
                Drift::None => {}
            }
        }
    }

    println!(
        "corpus: {} files, breakdown: {:?}",
        transcripts.len(),
        stats.totals
    );
    println!("unknown type distribution: {:?}", stats.unknown_types);

    assert!(
        stats.totals.get("message").copied().unwrap_or(0) > 0,
        "no line parsed as typed Message — parser or transcript format broke entirely"
    );
    assert!(
        typed_failures.is_empty(),
        "known types failed typed decode (schema drift?):\n{}",
        typed_failures.join("\n")
    );
}
