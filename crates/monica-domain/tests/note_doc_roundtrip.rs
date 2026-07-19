//! TS スキーマ（shared/block-editor/schema.ts）↔ Rust 型付きモデルの整合を fixture で固定する。
//! round-trip（deserialize → serialize）が入力と Value 等価であることが契約 — これが破れると
//! `block_subtree` の本番出力（synced block 解決）が保存形から乖離する。

use monica_domain::{BlockNode, DocNode, InlineNode, Mark};
use serde_json::Value;

const FULL_DOC: &str = include_str!("fixtures/full-doc.json");
const UNKNOWN_NODES: &str = include_str!("fixtures/unknown-nodes.json");

fn assert_roundtrip(source: &str) -> DocNode {
    let original: Value = serde_json::from_str(source).unwrap();
    let doc: DocNode = serde_json::from_str(source).unwrap();
    let reserialized = serde_json::to_value(&doc).unwrap();
    assert_eq!(reserialized, original);
    doc
}

/// typed parse が全部 `Unknown` に落ちていたら round-trip は空虚に通ってしまう。
/// 未知として残ったノード数を数えて、既知ノードが本当に型付き variant で受かったことを固定する。
fn count_unknown(doc: &DocNode) -> usize {
    fn walk_block(node: &BlockNode) -> usize {
        match node {
            BlockNode::Unknown(_) => 1,
            BlockNode::BlockGroup { content } | BlockNode::BlockContainer { content, .. } => {
                content.iter().flatten().map(walk_block).sum()
            }
            BlockNode::Paragraph { content }
            | BlockNode::Heading { content, .. }
            | BlockNode::Todo { content, .. }
            | BlockNode::Bullet { content }
            | BlockNode::Numbered { content, .. }
            | BlockNode::Toggle { content, .. }
            | BlockNode::Quote { content }
            | BlockNode::Callout { content, .. }
            | BlockNode::CodeBlock { content, .. } => {
                content.iter().flatten().map(walk_inline).sum()
            }
            _ => 0,
        }
    }
    fn walk_inline(node: &InlineNode) -> usize {
        match node {
            InlineNode::Unknown(_) => 1,
            InlineNode::Text { marks, .. }
            | InlineNode::LinkMention { marks, .. }
            | InlineNode::NoteMention { marks, .. }
            | InlineNode::HardBreak { marks } => marks
                .iter()
                .flatten()
                .map(|mark| usize::from(matches!(mark, Mark::Unknown(_))))
                .sum(),
        }
    }
    match doc {
        DocNode::Doc { content } => content.iter().flatten().map(walk_block).sum(),
        DocNode::Unknown(_) => 1,
    }
}

#[test]
fn full_doc_roundtrips_and_parses_typed() {
    let doc = assert_roundtrip(FULL_DOC);
    assert_eq!(count_unknown(&doc), 0, "全ノード型を網羅した fixture に Unknown は出ない");
}

#[test]
fn unknown_nodes_roundtrip_preserving_source() {
    let doc = assert_roundtrip(UNKNOWN_NODES);
    // 未知 block (chart) + 未知 inline (aiHint) + 未知 mark (highlight) の 3 つだけが Unknown
    assert_eq!(count_unknown(&doc), 3);
}

#[test]
fn empty_note_doc_roundtrips() {
    assert_roundtrip(monica_domain::EMPTY_NOTE_DOC);
}
