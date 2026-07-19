//! note content（ProseMirror doc JSON）→ markdown の読み取り専用投影。
//!
//! 真実はあくまで content JSON。ここは coding agent や CLI が構造ノイズなしに読むための
//! 派生ビューで、決して失敗しない（未知ノードは text を拾い、型不一致 doc は Value walker で
//! plain text に退避、garbage は空文字）。`note_doc` の型付きモデルの上に構築する。

use std::collections::HashSet;

use serde_json::Value;

use crate::note_doc::{
    value_collect_text, value_trimmed_text, BlockNode, DocNode, InlineNode, LinkMentionAttrs, Mark,
    NoteMentionAttrs, SyncedBlockAttrs,
};

/// transclusion（syncedBlock のインライン展開）の再帰上限。循環・多重展開の暴走を防ぐ。
const MAX_TRANSCLUSION_DEPTH: usize = 8;

/// noteMention のタイトル・syncedBlock の中身を外部（NoteStore）から解決する。
/// 解決できない場合（不在・削除済み・エラー）は `None` を返し、投影は参照記法に fallback する。
pub trait NoteDocResolver {
    /// export 時点の note 表示名スナップショット（`NoteKind::display_name` 相当）。
    fn note_display_name(&self, note_id: &str) -> Option<String>;
    /// `note_id` 内の `block_id` を持つ blockContainer subtree の JSON（`block_subtree` 相当）。
    fn block_subtree(&self, note_id: &str, block_id: &str) -> Option<String>;
}

/// syncedBlock の投影モード。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncedBlockMode {
    /// `![[note-7#^blk]]` 参照記法のまま残す。
    Reference,
    /// resolver で中身を解決してインライン展開する（解決不能・循環時は参照記法に fallback）。
    Expand,
}

/// ProseMirror doc JSON を markdown へ投影する。失敗しない。
pub fn to_markdown(content: &str, resolver: &dyn NoteDocResolver, mode: SyncedBlockMode) -> String {
    match serde_json::from_str::<DocNode>(content) {
        Ok(DocNode::Doc { content }) => {
            let mut renderer = Renderer { resolver, mode, visited: HashSet::new(), depth: 0 };
            let mut blocks = Vec::new();
            renderer.render_group(content.as_deref().unwrap_or_default(), &mut blocks);
            join_blocks(&blocks)
        }
        Ok(DocNode::Unknown(value)) => value_trimmed_text(&value),
        Err(_) => match serde_json::from_str::<Value>(content) {
            Ok(value) => value_trimmed_text(&value),
            Err(_) => String::new(),
        },
    }
}

/// 描画済みブロック。`is_list` は隣接ブロックとの区切り（list 同士は 1 改行、他は空行）に使う。
type Block = (String, bool);

fn join_blocks(blocks: &[Block]) -> String {
    let mut out = String::new();
    for (i, (text, is_list)) in blocks.iter().enumerate() {
        if i > 0 {
            let prev_list = blocks[i - 1].1;
            out.push_str(if prev_list && *is_list { "\n" } else { "\n\n" });
        }
        out.push_str(text);
    }
    out
}

struct Renderer<'r> {
    resolver: &'r dyn NoteDocResolver,
    mode: SyncedBlockMode,
    visited: HashSet<(String, String)>,
    depth: usize,
}

impl Renderer<'_> {
    /// blockGroup の子（blockContainer 列）を順に描画する。numbered の採番は
    /// `shared/block-editor/decorations.ts` の run ロジックと一致させる:
    /// 同一 group 内の連続 numbered 兄弟で番号を進め、style 変更・非 numbered で reset。
    fn render_group(&mut self, items: &[BlockNode], out: &mut Vec<Block>) {
        let mut run: usize = 0;
        let mut run_style: Option<String> = None;
        for item in items {
            match item {
                BlockNode::BlockGroup { content } => {
                    run = 0;
                    run_style = None;
                    self.render_group(content.as_deref().unwrap_or_default(), out);
                }
                BlockNode::BlockContainer { content, .. } => {
                    let children = content.as_deref().unwrap_or_default();
                    let Some(block_content) = children.first() else {
                        continue;
                    };
                    let marker = match block_content {
                        BlockNode::Numbered { attrs, .. } => {
                            let style =
                                attrs.as_ref().and_then(|a| a.style.as_deref()).unwrap_or("decimal");
                            if run_style.as_deref() != Some(style) {
                                run = 0;
                                run_style = Some(style.to_string());
                            }
                            let label = marker_label(style, run);
                            run += 1;
                            Some(label)
                        }
                        _ => {
                            run = 0;
                            run_style = None;
                            None
                        }
                    };
                    self.render_container(block_content, marker, &children[1..], out);
                }
                other => {
                    run = 0;
                    run_style = None;
                    self.render_container(other, None, &[], out);
                }
            }
        }
    }

    fn render_container(
        &mut self,
        block_content: &BlockNode,
        marker: Option<String>,
        nested: &[BlockNode],
        out: &mut Vec<Block>,
    ) {
        match self.render_block_content(block_content, marker) {
            Some((mut text, true)) => {
                if !nested.is_empty() {
                    let mut sub = Vec::new();
                    self.render_group(nested, &mut sub);
                    if !sub.is_empty() {
                        text.push('\n');
                        text.push_str(&indent_lines(&join_blocks(&sub), "    "));
                    }
                }
                out.push((text, true));
            }
            Some((text, false)) => {
                out.push((text, false));
                self.render_group(nested, out);
            }
            None => self.render_group(nested, out),
        }
    }

    fn render_block_content(&mut self, node: &BlockNode, marker: Option<String>) -> Option<Block> {
        match node {
            BlockNode::Paragraph { content } => {
                let text = self.inlines(content);
                (!text.is_empty()).then_some((text, false))
            }
            BlockNode::Heading { attrs, content } => {
                let level = attrs.as_ref().and_then(|a| a.level).unwrap_or(1).clamp(1, 6) as usize;
                let text = self.inlines(content);
                Some((format!("{} {text}", "#".repeat(level)), false))
            }
            BlockNode::Todo { attrs, content } => {
                let checked = attrs.as_ref().and_then(|a| a.checked).unwrap_or(false);
                let text = self.inlines(content);
                let mark = if checked { "[x]" } else { "[ ]" };
                Some((format!("- {mark} {text}"), true))
            }
            BlockNode::Bullet { content } => {
                let text = self.inlines(content);
                Some((format!("- {text}"), true))
            }
            BlockNode::Numbered { content, .. } => {
                let marker = marker.unwrap_or_else(|| "1.".to_string());
                let text = self.inlines(content);
                Some((format!("{marker} {text}"), true))
            }
            BlockNode::Quote { content } | BlockNode::Toggle { content, .. } => {
                let text = self.inlines(content);
                (!text.is_empty()).then(|| (prefix_lines(&text, "> "), false))
            }
            BlockNode::Callout { attrs, content } => {
                let kind = attrs.as_ref().and_then(|a| a.kind.as_deref()).unwrap_or("note");
                let body = self.inlines(content);
                let mut text = format!("> [!{kind}]");
                if !body.is_empty() {
                    text.push('\n');
                    text.push_str(&prefix_lines(&body, "> "));
                }
                Some((text, false))
            }
            BlockNode::CodeBlock { attrs, content } => {
                let language = attrs.as_ref().and_then(|a| a.language.as_deref()).unwrap_or("");
                let code = raw_text(content.as_deref().unwrap_or_default());
                // 本文が ``` 行を含むと固定 fence が途中で閉じるので、中の最長 backtick run より
                // 長い fence を張る（CommonMark の fenced code block 規則）。
                let fence = "`".repeat(max_backtick_run(&code).max(2) + 1);
                Some((format!("{fence}{language}\n{code}\n{fence}"), false))
            }
            BlockNode::Divider => Some(("---".to_string(), false)),
            BlockNode::Bookmark { attrs } => {
                let href = attrs.as_ref().and_then(|a| a.href.as_deref());
                let title = attrs
                    .as_ref()
                    .and_then(|a| a.title.as_ref())
                    .and_then(|t| t.as_deref())
                    .filter(|t| !t.is_empty());
                match href {
                    Some(href) => Some((format!("[{}]({href})", title.unwrap_or(href)), false)),
                    None => title.map(|t| (t.to_string(), false)),
                }
            }
            BlockNode::Image { attrs } => attrs
                .as_ref()
                .and_then(|a| a.src.as_ref())
                .and_then(|s| s.as_deref())
                .filter(|s| !s.is_empty())
                .map(|src| (format!("![]({src})"), false)),
            BlockNode::SyncedBlock { attrs } => self.render_synced(attrs.as_ref()),
            BlockNode::Unknown(value) => {
                let text = value_trimmed_text(value);
                (!text.is_empty()).then_some((text, false))
            }
            BlockNode::BlockGroup { .. } | BlockNode::BlockContainer { .. } => {
                let mut sub = Vec::new();
                self.render_group(std::slice::from_ref(node), &mut sub);
                (!sub.is_empty()).then(|| (join_blocks(&sub), false))
            }
        }
    }

    fn render_synced(&mut self, attrs: Option<&SyncedBlockAttrs>) -> Option<Block> {
        let note_id = attrs.and_then(|a| a.note_id.as_deref())?;
        let block_ids = attrs.and_then(|a| a.block_ids.as_deref()).unwrap_or_default();
        match self.mode {
            SyncedBlockMode::Reference => Some((synced_reference(note_id, block_ids), false)),
            SyncedBlockMode::Expand => Some((self.expand_synced(note_id, block_ids), false)),
        }
    }

    fn expand_synced(&mut self, note_id: &str, block_ids: &[String]) -> String {
        if block_ids.is_empty() || self.depth >= MAX_TRANSCLUSION_DEPTH {
            return synced_reference(note_id, block_ids);
        }
        let parts: Vec<String> = block_ids
            .iter()
            .map(|block_id| self.expand_one(note_id, block_id))
            .collect();
        parts.join("\n\n")
    }

    fn expand_one(&mut self, note_id: &str, block_id: &str) -> String {
        let fallback = || format!("![[{note_id}#^{block_id}]]");
        let key = (note_id.to_string(), block_id.to_string());
        if self.visited.contains(&key) {
            return fallback();
        }
        let Some(json) = self.resolver.block_subtree(note_id, block_id) else {
            return fallback();
        };
        let Ok(block) = serde_json::from_str::<BlockNode>(&json) else {
            return fallback();
        };
        self.visited.insert(key.clone());
        self.depth += 1;
        let mut sub = Vec::new();
        self.render_group(std::slice::from_ref(&block), &mut sub);
        self.depth -= 1;
        self.visited.remove(&key);
        if sub.is_empty() {
            fallback()
        } else {
            join_blocks(&sub)
        }
    }

    /// blockContent の `Option<Vec<InlineNode>>` を markdown インライン文字列へ。
    fn inlines(&self, content: &Option<Vec<InlineNode>>) -> String {
        self.render_inlines(content.as_deref().unwrap_or_default())
    }

    fn render_inlines(&self, inlines: &[InlineNode]) -> String {
        let mut out = String::new();
        for inline in inlines {
            match inline {
                InlineNode::Text { text, marks } => {
                    if let Some(text) = text {
                        out.push_str(&apply_marks(text, marks.as_deref().unwrap_or_default()));
                    }
                }
                InlineNode::LinkMention { attrs, marks } => {
                    let base = link_mention_md(attrs.as_ref());
                    if !base.is_empty() {
                        out.push_str(&apply_marks(&base, marks.as_deref().unwrap_or_default()));
                    }
                }
                InlineNode::NoteMention { attrs, marks } => {
                    let base = self.note_mention_md(attrs.as_ref());
                    if !base.is_empty() {
                        out.push_str(&apply_marks(&base, marks.as_deref().unwrap_or_default()));
                    }
                }
                InlineNode::HardBreak { .. } => out.push('\n'),
                InlineNode::Unknown(value) => value_collect_text(value, &mut out),
            }
        }
        out
    }

    fn note_mention_md(&self, attrs: Option<&NoteMentionAttrs>) -> String {
        let Some(note_id) = attrs.and_then(|a| a.note_id.as_deref()) else {
            return String::new();
        };
        match self.resolver.note_display_name(note_id) {
            Some(title) if !title.is_empty() => format!("[[{note_id}|{title}]]"),
            _ => format!("[[{note_id}]]"),
        }
    }
}

fn synced_reference(note_id: &str, block_ids: &[String]) -> String {
    if block_ids.is_empty() {
        format!("![[{note_id}]]")
    } else {
        block_ids
            .iter()
            .map(|block_id| format!("![[{note_id}#^{block_id}]]"))
            .collect::<Vec<_>>()
            .join("\n")
    }
}

fn link_mention_md(attrs: Option<&LinkMentionAttrs>) -> String {
    let href = attrs.and_then(|a| a.href.as_deref());
    let title = attrs.and_then(|a| a.title.as_deref()).filter(|t| !t.is_empty());
    match (title, href) {
        (Some(title), Some(href)) => format!("[{title}]({href})"),
        (None, Some(href)) => format!("[{href}]({href})"),
        (Some(title), None) => title.to_string(),
        (None, None) => String::new(),
    }
}

/// marks を text に適用する。ネスト順は code（最内）→ italic → bold → strike → link（最外）。
/// 読み取り投影なので markdown 特殊文字はエスケープしない。
fn apply_marks(base: &str, marks: &[Mark]) -> String {
    let mut bold = false;
    let mut italic = false;
    let mut strike = false;
    let mut code = false;
    let mut link: Option<&str> = None;
    for mark in marks {
        match mark {
            Mark::Bold => bold = true,
            Mark::Italic => italic = true,
            Mark::Strike => strike = true,
            Mark::Code => code = true,
            Mark::Link { attrs } => link = attrs.as_ref().and_then(|a| a.href.as_deref()),
            Mark::Unknown(_) => {}
        }
    }
    let mut text = base.to_string();
    if code {
        text = format!("`{text}`");
    }
    if italic {
        text = format!("*{text}*");
    }
    if bold {
        text = format!("**{text}**");
    }
    if strike {
        text = format!("~~{text}~~");
    }
    if let Some(href) = link {
        text = format!("[{text}]({href})");
    }
    text
}

/// codeBlock 用の生テキスト収集（marks を無視して text をそのまま連結）。
fn raw_text(inlines: &[InlineNode]) -> String {
    let mut out = String::new();
    for inline in inlines {
        match inline {
            InlineNode::Text { text: Some(text), .. } => out.push_str(text),
            InlineNode::HardBreak { .. } => out.push('\n'),
            InlineNode::Unknown(value) => value_collect_text(value, &mut out),
            _ => {}
        }
    }
    out
}

fn max_backtick_run(code: &str) -> usize {
    let mut max = 0;
    let mut run = 0;
    for ch in code.chars() {
        if ch == '`' {
            run += 1;
            max = max.max(run);
        } else {
            run = 0;
        }
    }
    max
}

fn prefix_lines(text: &str, prefix: &str) -> String {
    text.lines().map(|line| format!("{prefix}{line}")).collect::<Vec<_>>().join("\n")
}

fn indent_lines(text: &str, indent: &str) -> String {
    text.lines()
        .map(|line| if line.is_empty() { String::new() } else { format!("{indent}{line}") })
        .collect::<Vec<_>>()
        .join("\n")
}

fn marker_label(style: &str, index: usize) -> String {
    match style {
        "lower-alpha" => format!("{}.", alpha_label(index)),
        "lower-roman" => format!("{}.", roman_label(index + 1)),
        _ => format!("{}.", index + 1),
    }
}

fn alpha_label(mut index: usize) -> String {
    let mut out = String::new();
    loop {
        out.insert(0, char::from(b'a' + (index % 26) as u8));
        let next = index / 26;
        if next == 0 {
            break;
        }
        index = next - 1;
    }
    out
}

fn roman_label(mut value: usize) -> String {
    const TABLE: [(usize, &str); 13] = [
        (1000, "m"),
        (900, "cm"),
        (500, "d"),
        (400, "cd"),
        (100, "c"),
        (90, "xc"),
        (50, "l"),
        (40, "xl"),
        (10, "x"),
        (9, "ix"),
        (5, "v"),
        (4, "iv"),
        (1, "i"),
    ];
    let mut out = String::new();
    for (weight, glyph) in TABLE {
        while value >= weight {
            out.push_str(glyph);
            value -= weight;
        }
    }
    out
}
