//! markdown 投影（`to_markdown`）と plain text 投影（`plain_text`）の契約テスト。
//! full-doc fixture の全ノード型を golden markdown（Reference / Expand 両モード）で固定する。

use monica_domain::{plain_text, to_markdown, NoteDocResolver, SyncedBlockMode};

const FULL_DOC: &str = include_str!("fixtures/full-doc.json");
const UNKNOWN_NODES: &str = include_str!("fixtures/unknown-nodes.json");

/// note-42 のタイトルと note-7 の block を解決する fake resolver。
struct FakeResolver;

impl NoteDocResolver for FakeResolver {
    fn note_display_name(&self, note_id: &str) -> Option<String> {
        match note_id {
            "note-42" => Some("Target Note".to_string()),
            _ => None,
        }
    }

    fn block_subtree(&self, note_id: &str, block_id: &str) -> Option<String> {
        match (note_id, block_id) {
            ("note-7", "blk-a") => Some(container("blk-a", "synced A")),
            ("note-7", "blk-b") => Some(container("blk-b", "synced B")),
            _ => None,
        }
    }
}

fn container(id: &str, text: &str) -> String {
    format!(
        r#"{{"type":"blockContainer","attrs":{{"id":"{id}"}},"content":[{{"type":"paragraph","content":[{{"type":"text","text":"{text}"}}]}}]}}"#
    )
}

/// full-doc fixture の全ノード型を投影した golden markdown。syncedBlock は参照記法のまま。
const FULL_DOC_MD: &str = "\
plain ***styled***~~ gone~~` mono`[ linked](https://example.com)
[Example](https://example.com/x)**[Marked](https://example.com/y)**[[note-42|Target Note]]

## Heading

- [x] done
- item
1. first

> hidden

> quoted

> [!warning]
> careful

```rust
fn main() {}
```

---

[Post](https://example.com/post)

![[note-7#^blk-a]]
![[note-7#^blk-b]]

![](/api/assets/abc.png)";

/// Expand モードでは syncedBlock だけが resolver 経由の中身に置き換わる（他は同一）。
const FULL_DOC_EXPANDED_MD: &str = "\
plain ***styled***~~ gone~~` mono`[ linked](https://example.com)
[Example](https://example.com/x)**[Marked](https://example.com/y)**[[note-42|Target Note]]

## Heading

- [x] done
- item
1. first

> hidden

> quoted

> [!warning]
> careful

```rust
fn main() {}
```

---

[Post](https://example.com/post)

synced A

synced B

![](/api/assets/abc.png)";

#[test]
fn full_doc_reference_mode() {
    let md = to_markdown(FULL_DOC, &FakeResolver, SyncedBlockMode::Reference);
    assert_eq!(md, FULL_DOC_MD);
}

#[test]
fn full_doc_expand_mode() {
    let md = to_markdown(FULL_DOC, &FakeResolver, SyncedBlockMode::Expand);
    assert_eq!(md, FULL_DOC_EXPANDED_MD);
}

#[test]
fn unknown_nodes_keep_text() {
    let md = to_markdown(UNKNOWN_NODES, &FakeResolver, SyncedBlockMode::Reference);
    // 未知 inline (aiHint) の子テキストと未知 mark (highlight) 付き text を落とさない。
    assert!(md.contains("known "), "known text kept: {md:?}");
    assert!(md.contains("inline-unknown"), "unknown inline text kept: {md:?}");
    assert!(md.contains(" marked"), "highlighted text kept: {md:?}");
    // 未知 block (chart) は content=[] でテキストが無いので出力なし、既知 heading は生きる。
    assert!(md.contains("# extra attrs survive"), "known heading rendered: {md:?}");
}

#[test]
fn cyclic_transclusion_falls_back_to_reference() {
    // note-1#self が自分自身を含む synced block を返す → 参照記法に落ちて停止する。
    struct Cyclic;
    impl NoteDocResolver for Cyclic {
        fn note_display_name(&self, _: &str) -> Option<String> {
            None
        }
        fn block_subtree(&self, note_id: &str, block_id: &str) -> Option<String> {
            if (note_id, block_id) == ("note-1", "self") {
                Some(
                    r#"{"type":"blockContainer","attrs":{"id":"self"},"content":[{"type":"syncedBlock","attrs":{"noteId":"note-1","blockIds":["self"]}}]}"#
                        .to_string(),
                )
            } else {
                None
            }
        }
    }
    let doc = r#"{"type":"doc","content":[{"type":"blockGroup","content":[{"type":"blockContainer","content":[{"type":"syncedBlock","attrs":{"noteId":"note-1","blockIds":["self"]}}]}]}]}"#;
    let md = to_markdown(doc, &Cyclic, SyncedBlockMode::Expand);
    // 展開は 1 段で止まり、再帰は参照記法になる（panic / 無限ループしない）。
    assert!(md.contains("![[note-1#^self]]"), "cycle broken by reference: {md:?}");
}

#[test]
fn type_mismatch_doc_falls_back_to_plain_text() {
    // 既知タグ heading の content が配列でなく文字列 → typed parse 失敗 → Value walker で text 回収。
    let doc = r#"{"type":"doc","content":[{"type":"blockGroup","content":[{"type":"blockContainer","content":[{"type":"paragraph","content":[{"type":"text","text":"survived"}]}]}]}],"garbage":{"type":"heading","content":"not-an-array"}}"#;
    let md = to_markdown(doc, &FakeResolver, SyncedBlockMode::Reference);
    assert!(md.contains("survived"), "value fallback keeps text: {md:?}");
}

#[test]
fn garbage_is_empty() {
    assert_eq!(to_markdown("not json at all", &FakeResolver, SyncedBlockMode::Reference), "");
    assert_eq!(plain_text("not json at all"), "");
}

#[test]
fn plain_text_joins_blocks_with_newlines() {
    let doc = r#"{"type":"doc","content":[{"type":"blockGroup","content":[
        {"type":"blockContainer","content":[{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Title"}]}]},
        {"type":"blockContainer","content":[{"type":"paragraph","content":[{"type":"text","text":"body text"}]}]}
    ]}]}"#;
    assert_eq!(plain_text(doc), "Title\nbody text");
}

#[test]
fn plain_text_empty_doc_is_empty() {
    assert_eq!(plain_text(monica_domain::EMPTY_NOTE_DOC), "");
}

#[test]
fn plain_text_has_no_schema_vocabulary() {
    // FTS 索引の要: 構造語彙（paragraph / blockContainer / type）が本文に混ざらない。
    let body = plain_text(FULL_DOC);
    assert!(!body.contains("paragraph"), "no schema words: {body:?}");
    assert!(!body.contains("blockContainer"), "no schema words: {body:?}");
    assert!(body.contains("Heading"), "real text present: {body:?}");
}
