//! note content（ProseMirror doc JSON）の型付きモデル。
//!
//! `shared/block-editor/schema.ts` が定義する直列化形式（`doc → blockGroup →
//! blockContainer(blockContent, blockGroup?)`）と正確に一致させる。ここが Rust 側で
//! スキーマを知る唯一の場所で、TS ↔ Rust の整合は fixture round-trip テストで担保する。
//!
//! 保存形式はあくまで JSON テキスト（`Note.content: RawJson`）のまま。このモデルは
//! 読み取り時の解釈にだけ使い、round-trip（deserialize → serialize）が入力の意味を
//! 変えないことを不変条件とする:
//!
//! - 未知の `type` はどの階層でも `Unknown(serde_json::Value)` として raw のまま素通しする
//!   （frontend が新ノード型を先行追加しても backend でデータが消えない）。
//! - 既知ノード上の未知 attr は `extra`（`#[serde(flatten)]`）で保持する。
//! - ProseMirror の `Node.toJSON` は attrs を default 値・明示的 `null` 込みで全キー出力する
//!   ため、default が null の attr は `Option<Option<T>>`（missing → `None` / null →
//!   `Some(None)` / 値 → `Some(Some(v))`）で「キー欠落」と「明示的 null」を区別する。
//! - タグは一致するが payload が型不一致の JSON は typed parse 全体が失敗する（untagged
//!   fallback は未知タグしか救わない）。その場合は Value walker に丸ごと fallback して、
//!   valid JSON なら必ず走査できるという従来の挙動を維持する。

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};

const PREVIEW_MAX_CHARS: usize = 200;

/// `Option<Option<T>>` の deserialize ヘルパー。素の derive では JSON `null` が外側の
/// `None` に潰れて「キー欠落」と区別できなくなるため、値があれば必ず `Some(..)` に包む。
fn double_option<'de, T, D>(de: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    Deserialize::deserialize(de).map(Some)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum DocNode {
    Doc {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        content: Option<Vec<BlockNode>>,
    },
    #[serde(untagged)]
    Unknown(Value),
}

/// blockGroup / blockContainer / blockContent 全種をひとつの tagged enum で表す。
/// ProseMirror の位置制約（container の第 1 子 = blockContent、第 2 子 = blockGroup?）は
/// 型では強制しない — JSON 配列の位置別型付けは serde で不自然になるうえ、寛容な受理の
/// ほうがデータ消失防止に効く。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum BlockNode {
    BlockGroup {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        content: Option<Vec<BlockNode>>,
    },
    BlockContainer {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        attrs: Option<BlockContainerAttrs>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        content: Option<Vec<BlockNode>>,
    },
    Paragraph {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        content: Option<Vec<InlineNode>>,
    },
    Heading {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        attrs: Option<HeadingAttrs>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        content: Option<Vec<InlineNode>>,
    },
    Todo {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        attrs: Option<TodoAttrs>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        content: Option<Vec<InlineNode>>,
    },
    Bullet {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        content: Option<Vec<InlineNode>>,
    },
    Numbered {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        attrs: Option<NumberedAttrs>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        content: Option<Vec<InlineNode>>,
    },
    Toggle {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        attrs: Option<ToggleAttrs>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        content: Option<Vec<InlineNode>>,
    },
    Quote {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        content: Option<Vec<InlineNode>>,
    },
    Callout {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        attrs: Option<CalloutAttrs>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        content: Option<Vec<InlineNode>>,
    },
    CodeBlock {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        attrs: Option<CodeBlockAttrs>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        content: Option<Vec<InlineNode>>,
    },
    Divider,
    Bookmark {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        attrs: Option<BookmarkAttrs>,
    },
    SyncedBlock {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        attrs: Option<SyncedBlockAttrs>,
    },
    Image {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        attrs: Option<ImageAttrs>,
    },
    #[serde(untagged)]
    Unknown(Value),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum InlineNode {
    Text {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        text: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        marks: Option<Vec<Mark>>,
    },
    LinkMention {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        attrs: Option<LinkMentionAttrs>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        marks: Option<Vec<Mark>>,
    },
    NoteMention {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        attrs: Option<NoteMentionAttrs>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        marks: Option<Vec<Mark>>,
    },
    HardBreak {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        marks: Option<Vec<Mark>>,
    },
    #[serde(untagged)]
    Unknown(Value),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Mark {
    Bold,
    Italic,
    Strike,
    Code,
    Link {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        attrs: Option<LinkMarkAttrs>,
    },
    #[serde(untagged)]
    Unknown(Value),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BlockContainerAttrs {
    #[serde(default, deserialize_with = "double_option", skip_serializing_if = "Option::is_none")]
    pub id: Option<Option<String>>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HeadingAttrs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level: Option<i64>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TodoAttrs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checked: Option<bool>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NumberedAttrs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToggleAttrs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open: Option<bool>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CalloutAttrs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CodeBlockAttrs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wrap: Option<bool>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkAttrs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub href: Option<String>,
    #[serde(default, deserialize_with = "double_option", skip_serializing_if = "Option::is_none")]
    pub title: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option", skip_serializing_if = "Option::is_none")]
    pub description: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option", skip_serializing_if = "Option::is_none")]
    pub thumbnail: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option", skip_serializing_if = "Option::is_none")]
    pub favicon: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option", skip_serializing_if = "Option::is_none")]
    pub site_name: Option<Option<String>>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncedBlockAttrs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub block_ids: Option<Vec<String>>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageAttrs {
    #[serde(default, deserialize_with = "double_option", skip_serializing_if = "Option::is_none")]
    pub src: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option", skip_serializing_if = "Option::is_none")]
    pub upload_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option", skip_serializing_if = "Option::is_none")]
    pub width: Option<Option<serde_json::Number>>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LinkMentionAttrs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub href: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, deserialize_with = "double_option", skip_serializing_if = "Option::is_none")]
    pub favicon: Option<Option<String>>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteMentionAttrs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note_id: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LinkMarkAttrs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub href: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl BlockNode {
    fn child_blocks(&self) -> Option<&[BlockNode]> {
        match self {
            BlockNode::BlockGroup { content } | BlockNode::BlockContainer { content, .. } => {
                content.as_deref()
            }
            _ => None,
        }
    }

    fn inline_content(&self) -> Option<&[InlineNode]> {
        match self {
            BlockNode::Paragraph { content }
            | BlockNode::Heading { content, .. }
            | BlockNode::Todo { content, .. }
            | BlockNode::Bullet { content }
            | BlockNode::Numbered { content, .. }
            | BlockNode::Toggle { content, .. }
            | BlockNode::Quote { content }
            | BlockNode::Callout { content, .. }
            | BlockNode::CodeBlock { content, .. } => content.as_deref(),
            _ => None,
        }
    }

    fn container_id(&self) -> Option<&str> {
        match self {
            BlockNode::BlockContainer { attrs, .. } => {
                attrs.as_ref()?.id.as_ref()?.as_deref()
            }
            _ => None,
        }
    }
}

/// First non-empty block of a ProseMirror doc, in document order. blockContainer の
/// 先頭の子が常にその行の内容ノードなので、block type ごとの許可リストを持たずに済み、
/// エディタに block type が増えてもここは変わらない。
pub fn first_line_preview(content: &str) -> Option<String> {
    match serde_json::from_str::<DocNode>(content) {
        Ok(DocNode::Doc { content }) => content?.iter().find_map(find_first_line),
        Ok(DocNode::Unknown(value)) => value_find_first_line(&value),
        Err(_) => {
            let value: Value = serde_json::from_str(content).ok()?;
            value_find_first_line(&value)
        }
    }
}

/// synced block（transclusion）用: content JSON から `attrs.id == block_id` の blockContainer
/// を探し、その subtree（入れ子の blockGroup ごと）を JSON 文字列で返す。block type 非依存。
pub fn block_subtree(content: &str, block_id: &str) -> Option<String> {
    match serde_json::from_str::<DocNode>(content) {
        Ok(DocNode::Doc { content }) => {
            content?.iter().find_map(|node| find_block(node, block_id))
        }
        Ok(DocNode::Unknown(value)) => {
            value_find_block(&value, block_id).map(|node| node.to_string())
        }
        Err(_) => {
            let value: Value = serde_json::from_str(content).ok()?;
            value_find_block(&value, block_id).map(|node| node.to_string())
        }
    }
}

fn find_first_line(node: &BlockNode) -> Option<String> {
    if let BlockNode::BlockContainer { content, .. } = node {
        let children = content.as_deref()?;
        let mut text = String::new();
        if let Some(block_content) = children.first() {
            collect_block_text(block_content, &mut text);
        }
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.chars().take(PREVIEW_MAX_CHARS).collect());
        }
        // 空行 — 続きは入れ子の blockGroup（あれば）から
        return children.iter().skip(1).find_map(find_first_line);
    }
    match node {
        BlockNode::Unknown(value) => value_find_first_line(value),
        _ => {
            if let Some(blocks) = node.child_blocks() {
                blocks.iter().find_map(find_first_line)
            } else {
                node.inline_content()?.iter().find_map(|inline| match inline {
                    InlineNode::Unknown(value) => value_find_first_line(value),
                    _ => None,
                })
            }
        }
    }
}

fn collect_block_text(node: &BlockNode, out: &mut String) {
    match node {
        BlockNode::Unknown(value) => value_collect_text(value, out),
        _ => {
            if let Some(inlines) = node.inline_content() {
                for inline in inlines {
                    collect_inline_text(inline, out);
                }
            } else if let Some(blocks) = node.child_blocks() {
                for block in blocks {
                    collect_block_text(block, out);
                }
            }
        }
    }
}

fn collect_inline_text(node: &InlineNode, out: &mut String) {
    match node {
        InlineNode::Text { text: Some(text), .. } => out.push_str(text),
        InlineNode::Unknown(value) => value_collect_text(value, out),
        _ => {}
    }
}

fn find_block(node: &BlockNode, block_id: &str) -> Option<String> {
    if node.container_id() == Some(block_id) {
        return serde_json::to_string(node).ok();
    }
    match node {
        BlockNode::Unknown(value) => {
            value_find_block(value, block_id).map(|found| found.to_string())
        }
        _ => {
            if let Some(blocks) = node.child_blocks() {
                blocks.iter().find_map(|child| find_block(child, block_id))
            } else {
                node.inline_content()?.iter().find_map(|inline| match inline {
                    InlineNode::Unknown(value) => {
                        value_find_block(value, block_id).map(|found| found.to_string())
                    }
                    _ => None,
                })
            }
        }
    }
}

// ---- Value walker ----
// typed parse が失敗した doc（既知タグ + payload 型不一致）と `Unknown` subtree のための
// fallback。valid JSON なら必ず走査できるという保証は、型付きモデルではなくここが担う。

fn value_collect_text(node: &Value, out: &mut String) {
    if let Some(text) = node.get("text").and_then(|t| t.as_str()) {
        out.push_str(text);
    }
    if let Some(children) = node.get("content").and_then(|c| c.as_array()) {
        for child in children {
            value_collect_text(child, out);
        }
    }
}

fn value_find_first_line(node: &Value) -> Option<String> {
    let children = node.get("content").and_then(|c| c.as_array())?;
    if node.get("type").and_then(|t| t.as_str()) == Some("blockContainer") {
        let mut text = String::new();
        if let Some(block_content) = children.first() {
            value_collect_text(block_content, &mut text);
        }
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.chars().take(PREVIEW_MAX_CHARS).collect());
        }
        return children.iter().skip(1).find_map(value_find_first_line);
    }
    children.iter().find_map(value_find_first_line)
}

fn value_find_block<'a>(node: &'a Value, block_id: &str) -> Option<&'a Value> {
    if node.get("type").and_then(|t| t.as_str()) == Some("blockContainer")
        && node.get("attrs").and_then(|a| a.get("id")).and_then(|i| i.as_str()) == Some(block_id)
    {
        return Some(node);
    }
    node.get("content")
        .and_then(|c| c.as_array())?
        .iter()
        .find_map(|child| value_find_block(child, block_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc_with_text(text: &str) -> String {
        format!(
            r#"{{"type":"doc","content":[{{"type":"blockGroup","content":[{{"type":"blockContainer","content":[{{"type":"paragraph","content":[{{"type":"text","text":"{text}"}}]}}]}}]}}]}}"#
        )
    }

    fn doc_with_ids(blocks: &[(&str, &str)]) -> String {
        let containers: Vec<String> = blocks
            .iter()
            .map(|(id, text)| {
                format!(
                    r#"{{"type":"blockContainer","attrs":{{"id":"{id}"}},"content":[{{"type":"paragraph","content":[{{"type":"text","text":"{text}"}}]}}]}}"#
                )
            })
            .collect();
        format!(
            r#"{{"type":"doc","content":[{{"type":"blockGroup","content":[{}]}}]}}"#,
            containers.join(",")
        )
    }

    #[test]
    fn preview_empty_doc_is_none() {
        assert_eq!(first_line_preview(r#"{"type":"doc","content":[]}"#), None);
    }

    #[test]
    fn preview_skips_empty_first_block() {
        let doc = r#"{"type":"doc","content":[{"type":"blockGroup","content":[
            {"type":"blockContainer","content":[{"type":"paragraph"}]},
            {"type":"blockContainer","content":[{"type":"paragraph","content":[{"type":"text","text":"second"}]}]}
        ]}]}"#;
        assert_eq!(first_line_preview(doc), Some("second".to_string()));
    }

    #[test]
    fn preview_concatenates_inline_marks_within_one_block() {
        let doc = r#"{"type":"doc","content":[{"type":"blockGroup","content":[
            {"type":"blockContainer","content":[{"type":"heading","attrs":{"level":1},"content":[
                {"type":"text","text":"bold"},{"type":"text","marks":[{"type":"em"}],"text":" and em"}
            ]}]}
        ]}]}"#;
        assert_eq!(first_line_preview(doc), Some("bold and em".to_string()));
    }

    #[test]
    fn preview_is_block_type_agnostic() {
        // blockContainer の先頭の子を行として扱うので、quote や未知の block type でも拾える
        let doc = r#"{"type":"doc","content":[{"type":"blockGroup","content":[
            {"type":"blockContainer","content":[{"type":"quote","content":[{"type":"text","text":"quoted"}]}]}
        ]}]}"#;
        assert_eq!(first_line_preview(doc), Some("quoted".to_string()));

        let unknown = r#"{"type":"doc","content":[{"type":"blockGroup","content":[
            {"type":"blockContainer","content":[{"type":"mystery","content":[{"type":"text","text":"novel"}]}]}
        ]}]}"#;
        assert_eq!(first_line_preview(unknown), Some("novel".to_string()));
    }

    #[test]
    fn preview_truncates_on_char_boundary() {
        let long = "あ".repeat(300);
        let preview = first_line_preview(&doc_with_text(&long)).unwrap();
        assert_eq!(preview.chars().count(), PREVIEW_MAX_CHARS);
    }

    #[test]
    fn preview_garbage_is_none() {
        assert_eq!(first_line_preview("not json"), None);
    }

    #[test]
    fn preview_falls_back_on_type_mismatch() {
        // 既知タグ + payload 型不一致（level が文字列）は typed parse 全体を失敗させるが、
        // Value walker への fallback で従来どおり拾えること（回帰テスト）
        let doc = r#"{"type":"doc","content":[{"type":"blockGroup","content":[
            {"type":"blockContainer","content":[{"type":"heading","attrs":{"level":"one"},"content":[
                {"type":"text","text":"still here"}]}]}
        ]}]}"#;
        assert_eq!(first_line_preview(doc), Some("still here".to_string()));
    }

    #[test]
    fn block_subtree_finds_top_level() {
        let content = doc_with_ids(&[("a", "first"), ("b", "second")]);
        let sub = block_subtree(&content, "b").unwrap();
        let value: Value = serde_json::from_str(&sub).unwrap();
        assert_eq!(value["type"], "blockContainer");
        assert_eq!(value["attrs"]["id"], "b");
        assert_eq!(value["content"][0]["content"][0]["text"], "second");
    }

    #[test]
    fn block_subtree_finds_nested_with_children() {
        // parent(id=p) が子 blockGroup に child(id=c) を持つ。p を引くと subtree ごと返る。
        let content = r#"{"type":"doc","content":[{"type":"blockGroup","content":[
            {"type":"blockContainer","attrs":{"id":"p"},"content":[
                {"type":"paragraph","content":[{"type":"text","text":"parent"}]},
                {"type":"blockGroup","content":[
                    {"type":"blockContainer","attrs":{"id":"c"},"content":[
                        {"type":"paragraph","content":[{"type":"text","text":"child"}]}]}]}]}]}]}"#;

        let parent = block_subtree(content, "p").unwrap();
        let parent_value: Value = serde_json::from_str(&parent).unwrap();
        assert_eq!(parent_value["content"][1]["type"], "blockGroup", "子 blockGroup ごと返る");
        assert_eq!(parent_value["content"][1]["content"][0]["attrs"]["id"], "c");

        let child = block_subtree(content, "c").unwrap();
        let child_value: Value = serde_json::from_str(&child).unwrap();
        assert_eq!(child_value["attrs"]["id"], "c");
        assert_eq!(child_value["content"][0]["content"][0]["text"], "child");
    }

    #[test]
    fn block_subtree_missing_and_garbage_are_none() {
        let content = doc_with_ids(&[("a", "x")]);
        assert_eq!(block_subtree(&content, "missing"), None);
        assert_eq!(block_subtree("not json", "a"), None);
    }

    #[test]
    fn block_subtree_skips_container_without_matching_id() {
        // attrs.id が無い container は素通りし、後続の一致を拾う
        let content = r#"{"type":"doc","content":[{"type":"blockGroup","content":[
            {"type":"blockContainer","content":[{"type":"paragraph"}]},
            {"type":"blockContainer","attrs":{"id":"target"},"content":[
                {"type":"paragraph","content":[{"type":"text","text":"hit"}]}]}]}]}"#;
        let sub = block_subtree(content, "target").unwrap();
        let value: Value = serde_json::from_str(&sub).unwrap();
        assert_eq!(value["attrs"]["id"], "target");
    }

    #[test]
    fn block_subtree_falls_back_on_type_mismatch() {
        // 型不一致（checked が文字列）でも subtree 解決が壊れないこと（fallback 回帰テスト）
        let content = r#"{"type":"doc","content":[{"type":"blockGroup","content":[
            {"type":"blockContainer","attrs":{"id":"t"},"content":[
                {"type":"todo","attrs":{"checked":"yes"},"content":[{"type":"text","text":"x"}]}]}]}]}"#;
        let sub = block_subtree(content, "t").unwrap();
        let value: Value = serde_json::from_str(&sub).unwrap();
        assert_eq!(value["attrs"]["id"], "t");
        assert_eq!(value["content"][0]["attrs"]["checked"], "yes");
    }

    #[test]
    fn block_subtree_serialization_keeps_null_and_unknown_attrs() {
        // typed 経由で serialize し直しても、明示的 null と未知 attr が保存形と一致すること
        let content = r#"{"type":"doc","content":[{"type":"blockGroup","content":[
            {"type":"blockContainer","attrs":{"id":"z","collapsed":true},"content":[
                {"type":"image","attrs":{"src":null,"uploadId":"up-1","width":null}}]}]}]}"#;
        let sub = block_subtree(content, "z").unwrap();
        let value: Value = serde_json::from_str(&sub).unwrap();
        let original: Value = serde_json::from_str(content).unwrap();
        assert_eq!(value, original["content"][0]["content"][0]);
    }

    #[test]
    fn container_id_null_and_missing_are_distinct() {
        let with_null = r#"{"type":"blockContainer","attrs":{"id":null},"content":[]}"#;
        let node: BlockNode = serde_json::from_str(with_null).unwrap();
        assert_eq!(node.container_id(), None);
        assert_eq!(
            serde_json::to_value(&node).unwrap(),
            serde_json::from_str::<Value>(with_null).unwrap(),
            "明示的 null は null のまま出る"
        );

        let without_attrs = r#"{"type":"blockContainer","content":[]}"#;
        let node: BlockNode = serde_json::from_str(without_attrs).unwrap();
        assert_eq!(
            serde_json::to_value(&node).unwrap(),
            serde_json::from_str::<Value>(without_attrs).unwrap(),
            "attrs 欠落はキーごと出ない"
        );
    }
}
