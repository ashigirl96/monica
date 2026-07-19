//! Orphan-asset garbage collection: pure reachability + sweep helpers the runtime worker drives.
//! Kept out of `mod.rs` so the "which assets are referenced" logic is unit-testable without a store.

use std::collections::HashSet;
use std::path::Path;
use std::time::{Duration, SystemTime};

use monica_domain::RawJson;

use super::{parse_asset_id, ASSET_URL_PREFIX};

/// Asset ids referenced by any note. Walks each doc JSON and collects every string that is an
/// `ASSET_URL_PREFIX` URL whose tail is a well-formed asset id. Block-type agnostic (scans all
/// string values), so it keeps working if the image node's shape changes.
pub fn referenced_asset_ids(contents: &[RawJson]) -> HashSet<String> {
    let mut ids = HashSet::new();
    for content in contents {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(content.as_str()) {
            collect_refs(&value, &mut ids);
        }
    }
    ids
}

fn collect_refs(value: &serde_json::Value, ids: &mut HashSet<String>) {
    match value {
        serde_json::Value::String(s) => {
            if let Some(rest) = s.strip_prefix(ASSET_URL_PREFIX) {
                if parse_asset_id(rest).is_some() {
                    ids.insert(rest.to_string());
                }
            }
        }
        serde_json::Value::Array(arr) => arr.iter().for_each(|v| collect_refs(v, ids)),
        serde_json::Value::Object(map) => map.values().for_each(|v| collect_refs(v, ids)),
        _ => {}
    }
}

/// Delete assets not in `referenced`, subject to a `grace` period: an unreferenced file younger
/// than `grace` (by mtime) is kept, protecting the paste→autosave window and same-day undo. Only
/// files whose name is a valid asset id are ever touched — unknown files in the dir are left alone.
/// Returns the ids actually deleted.
pub fn sweep_orphan_assets(
    referenced: &HashSet<String>,
    grace: Duration,
) -> anyhow::Result<Vec<String>> {
    sweep_dir(&monica_paths::assets_dir()?, referenced, grace)
}

// dir を明示的に受ける本体。テストは MONICA_HOME 共有の assets/ ではなく temp dir を渡し、
// 並列テストの相互干渉（他テストが作った asset を grace=0 sweep が消す）を避ける。
fn sweep_dir(
    dir: &Path,
    referenced: &HashSet<String>,
    grace: Duration,
) -> anyhow::Result<Vec<String>> {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    let now = SystemTime::now();
    let mut deleted = Vec::new();
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if parse_asset_id(name).is_none() {
            continue; // 未知ファイルは GC 対象外
        }
        if referenced.contains(name) {
            continue;
        }
        // mtime が読めない / 未来（clock skew）のときは安全側に倒して残す。
        let within_grace = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|mtime| now.duration_since(mtime).ok())
            .map(|age| age < grace)
            .unwrap_or(true);
        if within_grace {
            continue;
        }
        if std::fs::remove_file(entry.path()).is_ok() {
            deleted.push(name.to_string());
        }
    }
    Ok(deleted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::Tmp;

    fn write_asset(dir: &Path) -> String {
        let id = format!("{}.png", uuid::Uuid::new_v4());
        std::fs::write(dir.join(&id), [0x89, 0x50, 0x4E, 0x47]).unwrap();
        id
    }

    fn doc_with_srcs(srcs: &[&str]) -> RawJson {
        let blocks: Vec<serde_json::Value> = srcs
            .iter()
            .map(|src| {
                serde_json::json!({
                    "type": "blockContainer",
                    "content": [{ "type": "image", "attrs": { "src": src, "uploadId": null } }]
                })
            })
            .collect();
        RawJson::from(
            serde_json::json!({
                "type": "doc",
                "content": [{ "type": "blockGroup", "content": blocks }]
            })
            .to_string(),
        )
    }

    #[test]
    fn referenced_ids_extracts_asset_urls_only() {
        let id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.png";
        let contents = vec![
            doc_with_srcs(&[
                &format!("/api/assets/{id}"),
                "https://example.com/external.png", // 外部 URL は無視
            ]),
            RawJson::from("not valid json{".to_string()), // 壊れた JSON はスキップ
        ];
        let refs = referenced_asset_ids(&contents);
        assert_eq!(refs.len(), 1);
        assert!(refs.contains(id));
    }

    #[test]
    fn referenced_ids_walks_nested_blocks() {
        let id = "11111111-2222-3333-4444-555555555555.webp";
        let nested = RawJson::from(
            serde_json::json!({
                "type": "doc",
                "content": [{ "type": "blockGroup", "content": [{
                    "type": "blockContainer",
                    "content": [
                        { "type": "paragraph" },
                        { "type": "blockGroup", "content": [{
                            "type": "blockContainer",
                            "content": [{ "type": "image", "attrs": { "src": format!("/api/assets/{id}") } }]
                        }]}
                    ]
                }]}]
            })
            .to_string(),
        );
        let refs = referenced_asset_ids(&[nested]);
        assert!(refs.contains(id));
    }

    #[test]
    fn sweep_deletes_unreferenced_respecting_grace() {
        let tmp = Tmp::new("gc-sweep");
        let dir = tmp.path();
        let referenced = write_asset(dir);
        let orphan = write_asset(dir);
        // asset id 形でない未知ファイルは触らない
        std::fs::write(dir.join("keep-me.txt"), b"x").unwrap();
        let mut refs = HashSet::new();
        refs.insert(referenced.clone());

        // grace 内なら未参照でも残る
        let deleted = sweep_dir(dir, &refs, Duration::from_secs(48 * 3600)).expect("sweep");
        assert!(deleted.is_empty(), "grace 内は削除しない");
        assert!(dir.join(&orphan).exists());

        // grace=0 なら未参照は消え、参照済みと未知ファイルは残る
        let deleted = sweep_dir(dir, &refs, Duration::ZERO).expect("sweep");
        assert_eq!(deleted, vec![orphan.clone()]);
        assert!(dir.join(&referenced).exists());
        assert!(!dir.join(&orphan).exists());
        assert!(dir.join("keep-me.txt").exists());
    }
}
