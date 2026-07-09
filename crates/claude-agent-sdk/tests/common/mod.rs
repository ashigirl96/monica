//! drift テスト（transcript_drift / wire_drift）共通の行分類。

use claude_agent_sdk::parser::ParsedLine;
use std::collections::BTreeMap;

#[derive(Default)]
pub struct DriftStats {
    pub totals: BTreeMap<&'static str, usize>,
    pub unknown_types: BTreeMap<String, usize>,
}

pub enum Drift {
    None,
    Malformed(String),
    /// 既知 type がデコード失敗 — 型 drift の疑い
    TypedDecodeFailure { ty: String, error: String },
}

pub fn record(parsed: ParsedLine, known_types: &[&str], stats: &mut DriftStats) -> Drift {
    match parsed {
        ParsedLine::Malformed { error, .. } => Drift::Malformed(error),
        ParsedLine::Empty => {
            *stats.totals.entry("empty").or_default() += 1;
            Drift::None
        }
        ParsedLine::Message(_) => {
            *stats.totals.entry("message").or_default() += 1;
            Drift::None
        }
        ParsedLine::Control(_) => {
            *stats.totals.entry("control").or_default() += 1;
            Drift::None
        }
        ParsedLine::Unknown { value, error } => {
            *stats.totals.entry("unknown").or_default() += 1;
            let ty = value
                .get("type")
                .and_then(|t| t.as_str())
                .unwrap_or("<no type>")
                .to_string();
            *stats.unknown_types.entry(ty.clone()).or_default() += 1;
            if known_types.contains(&ty.as_str()) {
                Drift::TypedDecodeFailure { ty, error }
            } else {
                Drift::None
            }
        }
    }
}
