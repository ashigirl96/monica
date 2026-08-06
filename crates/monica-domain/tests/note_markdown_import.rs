//! markdown 取り込み（`from_markdown`）の契約テスト。
//! 全ノード型を含む canonical markdown が `to_markdown` と round-trip することを固定する。

use serde_json::{json, Value};

use monica_domain::{from_markdown, plain_text, to_markdown, NoteDocResolver, SyncedBlockMode};

/// 何も解決しない resolver。noteMention は `[[id]]`、syncedBlock は参照記法のまま投影される。
struct NoResolver;

impl NoteDocResolver for NoResolver {
    fn note_display_name(&self, _note_id: &str) -> Option<String> {
        None
    }

    fn block_subtree(&self, _note_id: &str, _block_id: &str) -> Option<String> {
        None
    }
}

fn roundtrip(markdown: &str) -> String {
    let doc = serde_json::to_string(&from_markdown(markdown)).expect("doc serializes");
    to_markdown(&doc, &NoResolver, SyncedBlockMode::Reference)
}

fn doc_json(markdown: &str) -> Value {
    serde_json::to_value(from_markdown(markdown)).expect("doc serializes")
}

/// n 番目の blockContainer の先頭の子（= blockContent）。
fn content_at(doc: &Value, index: usize) -> &Value {
    &doc["content"][0]["content"][index]["content"][0]
}

/// block editor が対応する全ノード型を含む canonical markdown。
/// `to_markdown` の投影形と一字一句一致させてあり、import → export が恒等になる。
const CANONICAL_MD: &str = "\
# Title

plain **bold** *italic* ***styled*** <u>under</u> ~~gone~~ `mono` [link](https://example.com) [[note-42]]

## Section

- [ ] open task
- [x] done task
- bullet
    - nested bullet
    1. nested first
1. first
2. second
a. alpha
i. roman

> quoted
> lines

> [!warning]
> careful

```rust
fn main() {}
```

---

![[note-7#^blk-a]]
![[note-7#^blk-b]]

![](/api/assets/abc.png)

| head A | head B |
| --- | --- |
| **bold** \\| pipe | `code` |
|  | plain |";

#[test]
fn canonical_markdown_roundtrips() {
    assert_eq!(roundtrip(CANONICAL_MD), CANONICAL_MD);
}

#[test]
fn heading_levels_clamp_to_editor_range() {
    let doc = doc_json("# h1\n## h2\n### h3\n#### h4");
    for (i, level) in [1, 2, 3, 3].iter().enumerate() {
        assert_eq!(content_at(&doc, i)["type"], "heading");
        assert_eq!(content_at(&doc, i)["attrs"]["level"], *level);
    }
}

#[test]
fn heading_requires_space_after_hashes() {
    let doc = doc_json("#hashtag");
    assert_eq!(content_at(&doc, 0)["type"], "paragraph");
}

#[test]
fn list_markers_map_to_styles() {
    let doc = doc_json("1. a\n1) b\na. c\nii. d\n- e\n* f\n- [ ] g\n[x] h");
    let expected = [
        ("numbered", Some("decimal")),
        ("numbered", Some("decimal")),
        ("numbered", Some("lower-alpha")),
        ("numbered", Some("lower-roman")),
        ("bullet", None),
        ("bullet", None),
        ("todo", None),
        ("todo", None),
    ];
    for (i, (ty, style)) in expected.iter().enumerate() {
        assert_eq!(content_at(&doc, i)["type"], *ty, "index {i}");
        if let Some(style) = style {
            assert_eq!(content_at(&doc, i)["attrs"]["style"], *style, "index {i}");
        }
    }
    assert_eq!(content_at(&doc, 6)["attrs"]["checked"], false);
    assert_eq!(content_at(&doc, 7)["attrs"]["checked"], true);
}

#[test]
fn sentence_with_letter_period_is_not_a_list() {
    // "e.g. foo" は `.` 直後が空白でない（marker 判定は "e" で after が "g. foo"）ため list にしない
    let doc = doc_json("e.g. some example");
    assert_eq!(content_at(&doc, 0)["type"], "paragraph");
}

#[test]
fn indentation_nests_children_under_list_items() {
    let doc = doc_json("- parent\n    - child\n        - grandchild\n- sibling");
    let containers = &doc["content"][0]["content"];
    assert_eq!(containers.as_array().unwrap().len(), 2);
    let parent = &containers[0];
    let child = &parent["content"][1]["content"][0];
    assert_eq!(child["content"][0]["content"][0]["text"], "child");
    let grandchild = &child["content"][1]["content"][0];
    assert_eq!(grandchild["content"][0]["content"][0]["text"], "grandchild");
    assert_eq!(containers[1]["content"][0]["content"][0]["text"], "sibling");
}

#[test]
fn quote_lines_merge_with_hard_breaks() {
    let doc = doc_json("> first\n> second");
    let quote = content_at(&doc, 0);
    assert_eq!(quote["type"], "quote");
    assert_eq!(quote["content"][0]["text"], "first");
    assert_eq!(quote["content"][1]["type"], "hardBreak");
    assert_eq!(quote["content"][2]["text"], "second");
}

#[test]
fn callout_captures_kind_and_body() {
    let doc = doc_json("> [!warning]\n> careful\n> here");
    let callout = content_at(&doc, 0);
    assert_eq!(callout["type"], "callout");
    assert_eq!(callout["attrs"]["kind"], "warning");
    assert_eq!(callout["content"][0]["text"], "careful");
    assert_eq!(callout["content"][1]["type"], "hardBreak");
    assert_eq!(callout["content"][2]["text"], "here");
}

#[test]
fn unclosed_fence_consumes_to_end() {
    let doc = doc_json("```\ncode line\nstill code");
    let code = content_at(&doc, 0);
    assert_eq!(code["type"], "codeBlock");
    assert_eq!(code.get("attrs"), None, "language 未指定は attrs 省略でスキーマ既定に任せる");
    assert_eq!(code["content"][0]["text"], "code line\nstill code");
}

#[test]
fn fence_preserves_inner_indentation() {
    let doc = doc_json("- item\n    ```python\n    if x:\n        y()\n    ```");
    let item = &doc["content"][0]["content"][0];
    let code = &item["content"][1]["content"][0]["content"][0];
    assert_eq!(code["type"], "codeBlock");
    assert_eq!(code["attrs"]["language"], "python");
    assert_eq!(code["content"][0]["text"], "if x:\n    y()");
}

#[test]
fn consecutive_synced_refs_merge_per_note() {
    let doc = doc_json("![[note-7#^a]]\n![[note-7#^b]]\n![[note-8#^c]]\n\n![[note-9]]");
    let first = content_at(&doc, 0);
    assert_eq!(first["type"], "syncedBlock");
    assert_eq!(first["attrs"]["noteId"], "note-7");
    assert_eq!(first["attrs"]["blockIds"], json!(["a", "b"]));
    assert_eq!(content_at(&doc, 1)["attrs"]["noteId"], "note-8");
    assert_eq!(content_at(&doc, 2)["attrs"]["blockIds"], json!([]));
}

#[test]
fn image_requires_acceptable_src() {
    let doc = doc_json("![](/api/assets/a.png)\n\n![](https://example.com/b.png)\n\n![](data:image/png;base64,AAA)");
    assert_eq!(content_at(&doc, 0)["type"], "image");
    assert_eq!(content_at(&doc, 0)["attrs"]["src"], "/api/assets/a.png");
    assert_eq!(content_at(&doc, 1)["type"], "image");
    assert_eq!(content_at(&doc, 2)["type"], "paragraph", "data: URL は image にしない");
}

#[test]
fn inline_marks_nest_and_sort_by_schema_rank() {
    let doc = doc_json("[**Marked**](https://example.com/y)");
    let text = &content_at(&doc, 0)["content"][0];
    assert_eq!(text["text"], "Marked");
    assert_eq!(text["marks"][0]["type"], "bold");
    assert_eq!(text["marks"][1]["type"], "link");
    assert_eq!(text["marks"][1]["attrs"]["href"], "https://example.com/y");
}

#[test]
fn note_mention_drops_alias_title() {
    let doc = doc_json("see [[note-42|Target Note]] now");
    let inlines = &content_at(&doc, 0)["content"];
    assert_eq!(inlines[0]["text"], "see ");
    assert_eq!(inlines[1]["type"], "noteMention");
    assert_eq!(inlines[1]["attrs"]["noteId"], "note-42");
    assert_eq!(inlines[2]["text"], " now");
}

#[test]
fn intraword_underscore_is_not_emphasis() {
    let doc = doc_json("snake_case_name stays");
    let inlines = &content_at(&doc, 0)["content"];
    assert_eq!(inlines[0]["text"], "snake_case_name stays");
    assert_eq!(inlines.as_array().unwrap().len(), 1);
}

#[test]
fn backslash_escapes_punctuation() {
    let doc = doc_json(r"\*not em\* and \[not link\](x)");
    let inlines = &content_at(&doc, 0)["content"];
    assert_eq!(inlines[0]["text"], "*not em* and [not link](x)");
}

#[test]
fn unmatched_delimiters_stay_literal() {
    let doc = doc_json("2 * 3 * 4 = 24 and a_b");
    let inlines = &content_at(&doc, 0)["content"];
    // "* 3 *" は内容の両端が空白なので強調にならない
    assert_eq!(inlines[0]["text"], "2 * 3 * 4 = 24 and a_b");
}

#[test]
fn empty_markdown_yields_empty_group() {
    let doc = doc_json("");
    assert_eq!(doc["content"][0]["content"], json!([]));
}

#[test]
fn gfm_table_parses_header_and_pads_columns() {
    let doc = doc_json("| a | b |\n| --- | --- |\n| c |");
    let table = content_at(&doc, 0);
    assert_eq!(table["type"], "table");
    let rows = table["content"].as_array().unwrap();
    assert_eq!(rows.len(), 2, "delimiter 行は行にならない");
    assert_eq!(rows[0]["content"][0]["attrs"]["header"], true);
    assert_eq!(rows[0]["content"][0]["content"][0]["text"], "a");
    assert_eq!(rows[1]["content"][0]["content"][0]["text"], "c");
    assert_eq!(rows[1]["content"].as_array().unwrap().len(), 2, "不足セルは空で補う");
    assert_eq!(rows[1]["content"][1].get("attrs"), None, "body セルに header attr は付かない");
}

#[test]
fn table_without_delimiter_has_no_header() {
    let doc = doc_json("| a |\n| b |");
    let rows = content_at(&doc, 0)["content"].as_array().unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["content"][0].get("attrs"), None);
}

#[test]
fn single_pipe_line_stays_paragraph() {
    let doc = doc_json("| not a table |");
    assert_eq!(content_at(&doc, 0)["type"], "paragraph");
}

#[test]
fn table_cells_reach_plain_text_projection() {
    // FTS 索引（plain_text）が table セルのテキストを取りこぼさないこと
    let doc = serde_json::to_string(&from_markdown("| alpha | beta |\n| gamma | delta |"))
        .expect("doc serializes");
    let text = plain_text(&doc);
    // セル間に区切りが入り、隣接セルの語が連結されない（FTS トークンの防衛）
    assert_eq!(text, "alpha beta gamma delta");
}

#[test]
fn escaped_pipe_stays_inside_cell() {
    let doc = doc_json("| a \\| b | c |\n| d | e |");
    let first_cell = &content_at(&doc, 0)["content"][0]["content"][0];
    assert_eq!(first_cell["content"][0]["text"], "a | b");
}

#[test]
fn cell_with_backslash_before_pipe_roundtrips() {
    // `\` を素で出すと続く `\|` のエスケープを食い、区切りとしてセルが増える
    let markdown = "| a \\\\\\| b | c |\n| --- | --- |\n| d | e |";
    let doc = doc_json(markdown);
    let first_cell = &content_at(&doc, 0)["content"][0]["content"][0];
    assert_eq!(first_cell["content"][0]["text"], "a \\| b");
    assert_eq!(
        content_at(&doc, 0)["content"][0]["content"].as_array().unwrap().len(),
        2,
        "エスケープ済みの `|` でセルは増えない"
    );
    assert_eq!(roundtrip(markdown), markdown);
}

#[test]
fn delimiter_row_allows_rows_without_leading_pipe() {
    // GFM は先頭・末尾 `|` の省略を許す。delimiter 行がある入力でだけ受ける
    let doc = doc_json("a | b\n--- | ---\nc | d");
    let table = content_at(&doc, 0);
    assert_eq!(table["type"], "table");
    let rows = table["content"].as_array().unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["content"][1]["attrs"]["header"], true);
    assert_eq!(rows[0]["content"][1]["content"][0]["text"], "b");
    assert_eq!(rows[1]["content"][0]["content"][0]["text"], "c");
}

#[test]
fn pipes_in_prose_stay_paragraphs_without_delimiter_row() {
    // delimiter 行が無ければ先頭 `|` を要求する（本文が表に化けない）
    let doc = doc_json("foo | bar\nbaz | qux");
    assert_eq!(content_at(&doc, 0)["type"], "paragraph");
    assert_eq!(content_at(&doc, 1), &Value::Null, "折り返しとして 1 段落にまとまる");
}

#[test]
fn soft_wrapped_prose_stays_one_paragraph() {
    // 折り返された 1 段落を行ごとに割らない（空行だけが段落の区切り）
    let doc = doc_json("This is a\nwrapped paragraph\n\nnext one");
    let first = content_at(&doc, 0);
    assert_eq!(first["type"], "paragraph");
    assert_eq!(first["content"][0]["text"], "This is a");
    assert_eq!(first["content"][1]["type"], "hardBreak");
    assert_eq!(first["content"][2]["text"], "wrapped paragraph");
    assert_eq!(content_at(&doc, 1)["content"][0]["text"], "next one");
    assert_eq!(content_at(&doc, 2), &Value::Null);
}

#[test]
fn continuation_stops_at_the_next_construct() {
    // 継続行として食えるのは素の本文行だけ。heading は 1 行で閉じる（CommonMark と同じ）
    let doc = doc_json("intro line\n# Title\nbody\n- item\ncont\n\n```\nfence\n```");
    let expected = ["paragraph", "heading", "paragraph", "bullet", "codeBlock"];
    for (i, ty) in expected.iter().enumerate() {
        assert_eq!(content_at(&doc, i)["type"], *ty, "index {i}");
    }
    // list item は lazy continuation を受ける（`- item` + `cont` で 1 つ）
    let item = content_at(&doc, 3);
    assert_eq!(item["content"][1]["type"], "hardBreak");
    assert_eq!(item["content"][2]["text"], "cont");
}

#[test]
fn paragraph_hard_breaks_roundtrip() {
    let markdown = "wrapped one\nwrapped two\n\n- item\nlazy line";
    assert_eq!(roundtrip(markdown), markdown);
}

#[test]
fn continuation_stops_before_a_bare_table() {
    // 継続行の判定は実際の dispatch を試すので、delimiter 行で裏付けられた表を食わない
    let doc = doc_json("intro\na | b\n--- | ---\nc | d");
    assert_eq!(content_at(&doc, 0)["type"], "paragraph");
    assert_eq!(content_at(&doc, 0)["content"].as_array().unwrap().len(), 1);
    assert_eq!(content_at(&doc, 1)["type"], "table");
}

#[test]
fn code_span_keeps_inner_markdown_raw() {
    let doc = doc_json("`**not bold**` after");
    let inlines = &content_at(&doc, 0)["content"];
    assert_eq!(inlines[0]["text"], "**not bold**");
    assert_eq!(inlines[0]["marks"][0]["type"], "code");
    assert_eq!(inlines[1]["text"], " after");
}

#[test]
fn link_href_keeps_balanced_parens() {
    let doc = doc_json("[x](https://en.wikipedia.org/wiki/Foo_(film)) end");
    let inlines = &content_at(&doc, 0)["content"];
    assert_eq!(inlines[0]["text"], "x");
    assert_eq!(
        inlines[0]["marks"][0]["attrs"]["href"],
        "https://en.wikipedia.org/wiki/Foo_(film)"
    );
    assert_eq!(inlines[1]["text"], " end");
}

#[test]
fn deep_indentation_flattens_instead_of_overflowing_the_stack() {
    // 段階的に深まるインデントは再帰の深さ = スタック消費。上限を超えたら平坦化する。
    let markdown: String = (0..2000).map(|i| format!("{}- x\n", " ".repeat(i))).collect();
    let parsed = std::thread::Builder::new()
        .stack_size(2 * 1024 * 1024)
        .spawn(move || serde_json::to_string(&from_markdown(&markdown)).expect("doc serializes"))
        .expect("thread spawns")
        .join();
    assert!(parsed.is_ok(), "深い入れ子でスタックを溢れさせない");
}
