//! ローカルの Claude Code transcript を drift 検知コーパスとして使うテスト。
//!
//! ~/.claude/projects/**/*.jsonl の最新 5 ファイルを全行 parse_line に通す。
//! transcript は stream-json の wire フォーマットとは別物（camelCase 封筒フィールド等）だが、
//! user / assistant 行の中身はほぼ同型なので、常に最新の CLI が吐いた実データで
//! パーサの頑健性と型 drift を確認できる。環境依存のため live smoke と同じく
//! `cargo test -p claude-agent-sdk -- --ignored` でローカル実行のみ。

use claude_agent_sdk::parser::{parse_line, ParsedLine};
use std::collections::BTreeMap;
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

    let mut totals: BTreeMap<&'static str, usize> = BTreeMap::new();
    let mut unknown_types: BTreeMap<String, usize> = BTreeMap::new();
    let mut typed_failures: Vec<String> = Vec::new();

    for path in &transcripts {
        let content = std::fs::read_to_string(path).expect("read transcript");
        for line in content.lines() {
            match parse_line(line) {
                ParsedLine::Malformed { error, .. } => {
                    panic!("Malformed line in {}: {error}", path.display())
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
                    // 既知 type がデコード失敗した場合は型 drift の疑い — 明示的に集める
                    if ["user", "assistant", "result", "stream_event"].contains(&ty.as_str()) {
                        typed_failures.push(format!("{ty}: {error}"));
                    }
                    *unknown_types.entry(ty).or_default() += 1;
                }
            }
        }
    }

    println!("corpus: {} files, breakdown: {totals:?}", transcripts.len());
    println!("unknown type distribution: {unknown_types:?}");

    assert!(
        totals.get("message").copied().unwrap_or(0) > 0,
        "no line parsed as typed Message — parser or transcript format broke entirely"
    );
    assert!(
        typed_failures.is_empty(),
        "known types failed typed decode (schema drift?):\n{}",
        typed_failures.join("\n")
    );
}
