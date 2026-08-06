//! markdown → note content（ProseMirror doc JSON）の逆投影。
//!
//! `note_markdown::to_markdown` と対になる paste 取り込み用パーサ。決して失敗せず、
//! どの構文にもマッチしない行は paragraph に落とす。ブロック ID は発行しない
//! （attrs なしの blockContainer を返し、frontend の paste 経路が reissue する）。
//!
//! to_markdown との対応で非可逆な点:
//! - toggle は `> ` に投影されるため、import では quote になる。
//! - list 以外の入れ子（heading 配下など）は export 時に平坦化されるため復元しない。
//! - `[[id|title]]` の title は捨てる（noteMention の表示名は NodeView が解決する）。

use serde_json::Map;

use crate::note_doc::{
    BlockNode, CalloutAttrs, CodeBlockAttrs, DocNode, HeadingAttrs, ImageAttrs, InlineNode,
    LinkMarkAttrs, Mark, NoteMentionAttrs, NumberedAttrs, SyncedBlockAttrs, TableCellAttrs,
    TodoAttrs,
};

/// asset 配信 URL の prefix。`shared/block-editor/schema.ts` の ASSET_URL_PREFIX と一致させる。
const ASSET_URL_PREFIX: &str = "/api/assets/";

const TAB_WIDTH: usize = 4;

/// 入れ子の上限。1 段ごとに `parse_blocks` / `parse_block` が再帰するので、深さは
/// そのままスタック消費になる。段階的にインデントが深まるだけの入力（数千行）で
/// tokio worker の 2MB スタックを溢れさせられるため、これ以上は平坦化する。
const MAX_NEST_DEPTH: usize = 64;

/// markdown を ProseMirror doc（`doc → blockGroup → blockContainer*`）へ解釈する。失敗しない。
pub fn from_markdown(markdown: &str) -> DocNode {
    let lines: Vec<Line> = markdown.lines().map(Line::parse).collect();
    let mut parser = Parser { lines, pos: 0 };
    let blocks = parser.parse_blocks(0, 0);
    DocNode::Doc {
        content: Some(vec![BlockNode::BlockGroup { content: Some(blocks) }]),
    }
}

#[derive(Clone, Copy)]
struct Line<'a> {
    /// 行頭インデント幅（space=1, tab=4 換算のカラム数）。
    indent: usize,
    /// インデントを除いた本文。
    rest: &'a str,
}

impl<'a> Line<'a> {
    fn parse(raw: &'a str) -> Self {
        let mut indent = 0;
        let mut offset = 0;
        for ch in raw.chars() {
            match ch {
                ' ' => indent += 1,
                '\t' => indent += TAB_WIDTH,
                _ => break,
            }
            offset += ch.len_utf8();
        }
        Line { indent, rest: &raw[offset..] }
    }

    fn is_blank(&self) -> bool {
        self.rest.is_empty()
    }
}

struct Parser<'a> {
    lines: Vec<Line<'a>>,
    pos: usize,
}

impl Parser<'_> {
    /// `min_indent` 以上のインデントの行が続く限り blockContainer 列を組み立てる。
    fn parse_blocks(&mut self, min_indent: usize, depth: usize) -> Vec<BlockNode> {
        let mut out = Vec::new();
        loop {
            while self.lines.get(self.pos).is_some_and(|l| l.is_blank()) {
                self.pos += 1;
            }
            let Some(line) = self.lines.get(self.pos) else { break };
            if line.indent < min_indent {
                break;
            }
            let ind = line.indent;
            self.parse_block(ind, depth, &mut out);
        }
        out
    }

    fn parse_block(&mut self, ind: usize, depth: usize, out: &mut Vec<BlockNode>) {
        let content = self
            .try_code_block(ind)
            .or_else(|| self.try_callout(ind))
            .or_else(|| self.try_quote(ind))
            .or_else(|| self.try_synced(ind))
            .or_else(|| self.try_table(ind))
            .unwrap_or_else(|| {
                let text = self.lines[self.pos].rest;
                self.pos += 1;
                single_line_block(text)
            });
        // より深いインデントの後続行はこのブロックの子。ただし atom（カーソルを
        // 置けない block）には子を入れられないので同階層へ繰り上げる。
        // 上限に達したら子を作らない = 以降の深いインデントは同階層の兄弟になる。
        let children = if depth + 1 < MAX_NEST_DEPTH {
            self.parse_blocks(ind + 1, depth + 1)
        } else {
            Vec::new()
        };
        if is_atom(&content) {
            out.push(container(content, Vec::new()));
            out.extend(children);
        } else {
            out.push(container(content, children));
        }
    }

    /// ```` ```lang ```` フェンス。閉じフェンスが無ければ末尾までをコードとする。
    fn try_code_block(&mut self, ind: usize) -> Option<BlockNode> {
        let text = self.lines[self.pos].rest;
        let fence_char = text.chars().next().filter(|c| matches!(c, '`' | '~'))?;
        let fence_len = text.chars().take_while(|c| *c == fence_char).count();
        if fence_len < 3 {
            return None;
        }
        let info = text[fence_len..].trim();
        if fence_char == '`' && info.contains('`') {
            return None;
        }
        self.pos += 1;
        let mut code_lines: Vec<String> = Vec::new();
        while let Some(line) = self.lines.get(self.pos) {
            if is_closing_fence(line.rest, fence_char, fence_len) {
                self.pos += 1;
                break;
            }
            // ブロック自身のインデントだけ剥がし、それより深い分はコードとして保持する
            let extra = line.indent.saturating_sub(ind);
            code_lines.push(format!("{}{}", " ".repeat(extra), line.rest));
            self.pos += 1;
        }
        let code = code_lines.join("\n");
        let content =
            (!code.is_empty()).then(|| vec![InlineNode::Text { text: Some(code), marks: None }]);
        // language 未指定は attrs ごと省略してスキーマ既定（"plain text"）に任せる
        let attrs = (!info.is_empty()).then(|| CodeBlockAttrs {
            language: Some(info.to_string()),
            wrap: None,
            extra: Map::new(),
        });
        Some(BlockNode::CodeBlock { attrs, content })
    }

    /// `> [!kind]` 行 + 続く同インデントの `> ` 行を 1 つの callout にまとめる。
    fn try_callout(&mut self, ind: usize) -> Option<BlockNode> {
        let kind = callout_kind(self.lines[self.pos].rest)?.to_string();
        self.pos += 1;
        let mut body: Vec<&str> = Vec::new();
        while let Some(line) = self.lines.get(self.pos) {
            if line.indent != ind || callout_kind(line.rest).is_some() {
                break;
            }
            let Some(rest) = quote_body(line.rest) else { break };
            body.push(rest);
            self.pos += 1;
        }
        Some(BlockNode::Callout {
            attrs: Some(CalloutAttrs { kind: Some(kind), extra: Map::new() }),
            content: parse_multiline_inlines(&body),
        })
    }

    /// 連続する同インデントの `> ` 行を hardBreak 区切りの 1 つの quote にまとめる。
    fn try_quote(&mut self, ind: usize) -> Option<BlockNode> {
        quote_body(self.lines[self.pos].rest)?;
        let mut body: Vec<&str> = Vec::new();
        while let Some(line) = self.lines.get(self.pos) {
            if line.indent != ind || callout_kind(line.rest).is_some() {
                break;
            }
            let Some(rest) = quote_body(line.rest) else { break };
            body.push(rest);
            self.pos += 1;
        }
        Some(BlockNode::Quote { content: parse_multiline_inlines(&body) })
    }

    /// GFM table。連続する同インデントの行を 1 つの table にまとめる。
    /// 2 行目が delimiter 行（`| --- |`）なら 1 行目を header にする。
    /// `|` 単独行は本文にもあり得るので、2 行以上そろったときだけ table と解釈する。
    fn try_table(&mut self, ind: usize) -> Option<BlockNode> {
        let start = self.pos;
        // delimiter 行が裏付けにあるときだけ先頭 `|` の省略（`a | b`）を許す。GFM は常に
        // 省略可だが、delimiter は GFM が表の必須要素でもあるので、これが無い入力
        // （= to_markdown が出す header なし表）で省略まで許すと ` | ` を含む本文 2 行が
        // 表に化ける。
        let bare_ok = self
            .lines
            .get(start + 1)
            .filter(|line| line.indent == ind)
            .and_then(|line| table_row_cells(line.rest, true))
            .is_some_and(|cells| is_delimiter_row(&cells));
        table_row_cells(self.lines[start].rest, bare_ok)?;
        let mut raw_rows: Vec<Vec<String>> = Vec::new();
        let mut header = false;
        while let Some(line) = self.lines.get(self.pos) {
            if line.indent != ind {
                break;
            }
            let Some(cells) = table_row_cells(line.rest, bare_ok) else { break };
            if raw_rows.len() == 1 && !header && is_delimiter_row(&cells) {
                header = true;
            } else {
                raw_rows.push(cells);
            }
            self.pos += 1;
        }
        if self.pos - start < 2 || raw_rows.is_empty() {
            self.pos = start;
            return None;
        }
        // 列数は最大行に揃え、足りないセルは空で補う（描画・編集を単純に保つ）
        let width = raw_rows.iter().map(Vec::len).max().unwrap_or(1).max(1);
        let rows = raw_rows
            .iter()
            .enumerate()
            .map(|(i, cells)| {
                let is_header = header && i == 0;
                let row_cells = (0..width)
                    .map(|c| BlockNode::TableCell {
                        attrs: is_header.then(|| TableCellAttrs {
                            header: Some(true),
                            extra: Map::new(),
                        }),
                        content: parse_inlines(cells.get(c).map_or("", String::as_str)),
                    })
                    .collect();
                BlockNode::TableRow { content: Some(row_cells) }
            })
            .collect();
        Some(BlockNode::Table { content: Some(rows) })
    }

    /// `![[note]]` / `![[note#^blk]]`。同一 note の block 参照が連続する場合は
    /// 1 つの syncedBlock にまとめる（`to_markdown` が 1 block を複数行に開く投影の逆）。
    fn try_synced(&mut self, ind: usize) -> Option<BlockNode> {
        let (note_id, first_block) = synced_ref(self.lines[self.pos].rest)?;
        self.pos += 1;
        let mut block_ids = Vec::new();
        if let Some(block) = first_block {
            block_ids.push(block);
            while let Some(line) = self.lines.get(self.pos) {
                if line.indent != ind {
                    break;
                }
                match synced_ref(line.rest) {
                    Some((next_note, Some(block))) if next_note == note_id => {
                        block_ids.push(block);
                        self.pos += 1;
                    }
                    _ => break,
                }
            }
        }
        Some(BlockNode::SyncedBlock {
            attrs: Some(SyncedBlockAttrs {
                note_id: Some(note_id),
                block_ids: Some(block_ids),
                extra: Map::new(),
            }),
        })
    }
}

fn container(content: BlockNode, children: Vec<BlockNode>) -> BlockNode {
    let mut inner = vec![content];
    if !children.is_empty() {
        inner.push(BlockNode::BlockGroup { content: Some(children) });
    }
    BlockNode::BlockContainer { attrs: None, content: Some(inner) }
}

/// 子ブロックを持たせない block。atom（カーソル不可）に加え、table もエディタ側の
/// indent ガードと揃えて配下に子ツリーを作らない。
fn is_atom(node: &BlockNode) -> bool {
    matches!(
        node,
        BlockNode::Divider
            | BlockNode::Image { .. }
            | BlockNode::SyncedBlock { .. }
            | BlockNode::Table { .. }
    )
}

fn single_line_block(text: &str) -> BlockNode {
    if thematic_break(text) {
        return BlockNode::Divider;
    }
    heading(text)
        .or_else(|| todo(text))
        .or_else(|| bullet(text))
        .or_else(|| numbered(text))
        .or_else(|| image(text))
        .unwrap_or_else(|| BlockNode::Paragraph { content: parse_inlines(text) })
}

/// `---` / `***` / `___`（同一文字 3 つ以上のみの行）。
fn thematic_break(text: &str) -> bool {
    let t = text.trim_end();
    let Some(first) = t.chars().next() else { return false };
    matches!(first, '-' | '*' | '_') && t.len() >= 3 && t.chars().all(|c| c == first)
}

fn heading(text: &str) -> Option<BlockNode> {
    let hashes = text.bytes().take_while(|&b| b == b'#').count();
    if hashes == 0 || hashes > 6 {
        return None;
    }
    let body = match &text[hashes..] {
        "" => "",
        rest => rest.strip_prefix(' ')?,
    };
    // スキーマの heading は level 1..=3（h4 以降は最深に丸める）
    let level = hashes.min(3) as i64;
    Some(BlockNode::Heading {
        attrs: Some(HeadingAttrs { level: Some(level), extra: Map::new() }),
        content: parse_inlines(body),
    })
}

/// `- [ ] text` / `* [x] text` / マーカー省略の `[ ] text`（input rule の alias と同じ受理）。
fn todo(text: &str) -> Option<BlockNode> {
    let after_marker = text
        .strip_prefix("- ")
        .or_else(|| text.strip_prefix("* "))
        .or_else(|| text.strip_prefix("+ "))
        .unwrap_or(text);
    let inner = after_marker.strip_prefix('[')?;
    let (checked, after) = if let Some(rest) =
        inner.strip_prefix("x]").or_else(|| inner.strip_prefix("X]"))
    {
        (true, rest)
    } else if let Some(rest) = inner.strip_prefix(" ]").or_else(|| inner.strip_prefix(']')) {
        (false, rest)
    } else {
        return None;
    };
    let body = match after {
        "" => "",
        rest => rest.strip_prefix(' ')?,
    };
    Some(BlockNode::Todo {
        attrs: Some(TodoAttrs { checked: Some(checked), extra: Map::new() }),
        content: parse_inlines(body),
    })
}

fn bullet(text: &str) -> Option<BlockNode> {
    let body = text
        .strip_prefix("- ")
        .or_else(|| text.strip_prefix("* "))
        .or_else(|| text.strip_prefix("+ "))?;
    Some(BlockNode::Bullet { content: parse_inlines(body) })
}

/// `1. ` / `1) ` → decimal、`a. ` → lower-alpha、`i. ` → lower-roman
/// （roman を alpha より先に判定する — input rule と同じ）。番号自体は捨てる（採番は表示側）。
fn numbered(text: &str) -> Option<BlockNode> {
    let sep = text.find(['.', ')'])?;
    let marker = &text[..sep];
    if marker.is_empty() || marker.len() > 4 {
        return None;
    }
    let style = if marker.bytes().all(|b| b.is_ascii_digit()) {
        if marker.len() > 3 {
            return None;
        }
        "decimal"
    } else if text.as_bytes()[sep] == b'.' && marker.bytes().all(|b| b.is_ascii_lowercase()) {
        if is_roman(marker) {
            "lower-roman"
        } else if marker.len() == 1 {
            "lower-alpha"
        } else {
            return None;
        }
    } else {
        return None;
    };
    let body = match &text[sep + 1..] {
        "" => "",
        rest => rest.strip_prefix(' ')?,
    };
    Some(BlockNode::Numbered {
        attrs: Some(NumberedAttrs { style: Some(style.to_string()), extra: Map::new() }),
        content: parse_inlines(body),
    })
}

fn is_roman(marker: &str) -> bool {
    matches!(marker, "i" | "ii" | "iii" | "iv" | "v" | "vi" | "vii" | "viii" | "ix" | "x")
}

fn callout_kind(text: &str) -> Option<&str> {
    let rest = text.strip_prefix("> [!").or_else(|| text.strip_prefix(">[!"))?;
    let end = rest.find(']')?;
    let kind = &rest[..end];
    let valid = !kind.is_empty()
        && kind.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    (valid && rest[end + 1..].trim().is_empty()).then_some(kind)
}

fn quote_body(text: &str) -> Option<&str> {
    let rest = text.strip_prefix('>')?;
    Some(rest.strip_prefix(' ').unwrap_or(rest))
}

fn is_closing_fence(text: &str, fence_char: char, min_len: usize) -> bool {
    let t = text.trim_end();
    t.len() >= min_len && t.chars().all(|c| c == fence_char)
}

/// `| a | b |` 行をセル列に分解する。末尾 `|` は省略可。`bare_ok` なら先頭 `|` も省略可
/// （代わりに区切りの `|` を 1 つ以上含むことを要求する — 本文 1 行を表の行と読まないため）。
/// `\|` はセル区切りにしない（エスケープ解決は inline parser に任せる）。
fn table_row_cells(text: &str, bare_ok: bool) -> Option<Vec<String>> {
    let trimmed = text.trim_end();
    let (inner, bare) = match trimmed.strip_prefix('|') {
        Some(rest) => (rest, false),
        None if bare_ok => (trimmed, true),
        None => return None,
    };
    let inner = inner.strip_suffix('|').unwrap_or(inner);
    let mut cells = Vec::new();
    let mut current = String::new();
    let mut chars = inner.chars();
    while let Some(ch) = chars.next() {
        match ch {
            '\\' => {
                current.push('\\');
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            }
            '|' => cells.push(std::mem::take(&mut current).trim().to_string()),
            _ => current.push(ch),
        }
    }
    cells.push(current.trim().to_string());
    if bare && cells.len() < 2 {
        return None;
    }
    Some(cells)
}

/// header と body を区切る `| --- | :--- |` 行か。alignment 記号は受理して捨てる。
fn is_delimiter_row(cells: &[String]) -> bool {
    !cells.is_empty()
        && cells.iter().all(|cell| {
            let c = cell.strip_prefix(':').unwrap_or(cell);
            let c = c.strip_suffix(':').unwrap_or(c);
            !c.is_empty() && c.bytes().all(|b| b == b'-')
        })
}

fn synced_ref(text: &str) -> Option<(String, Option<String>)> {
    let inner = text.trim_end().strip_prefix("![[")?.strip_suffix("]]")?;
    if inner.is_empty() || inner.contains('[') || inner.contains(']') {
        return None;
    }
    match inner.split_once("#^") {
        Some((note, block)) if !note.is_empty() && !block.is_empty() => {
            Some((note.to_string(), Some(block.to_string())))
        }
        Some(_) => None,
        None => Some((inner.to_string(), None)),
    }
}

/// 行全体が `![alt](src)` のときだけ image block。src はエディタの
/// `acceptedPastedImageSrc` と同じく自前 asset か http(s) のみ受け入れる。
fn image(text: &str) -> Option<BlockNode> {
    let inner = text.trim_end().strip_prefix("![")?;
    let close = inner.find(']')?;
    let src = inner[close + 1..].strip_prefix('(')?.strip_suffix(')')?;
    let acceptable = !src.contains(char::is_whitespace)
        && !src.contains(')')
        && (src.starts_with(ASSET_URL_PREFIX)
            || src.starts_with("http://")
            || src.starts_with("https://"));
    if !acceptable {
        return None;
    }
    Some(BlockNode::Image {
        attrs: Some(ImageAttrs {
            src: Some(Some(src.to_string())),
            upload_id: None,
            width: None,
            extra: Map::new(),
        }),
    })
}

// ---- inline ----

fn parse_inlines(text: &str) -> Option<Vec<InlineNode>> {
    let mut out = Vec::new();
    parse_inline_into(text, &[], &mut out);
    (!out.is_empty()).then_some(out)
}

/// 複数行（quote / callout の本文）を hardBreak 区切りで 1 つの inline 列にする。
fn parse_multiline_inlines(lines: &[&str]) -> Option<Vec<InlineNode>> {
    if lines.iter().all(|line| line.is_empty()) {
        return None;
    }
    let mut out = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        if i > 0 {
            out.push(InlineNode::HardBreak { marks: None });
        }
        parse_inline_into(line, &[], &mut out);
    }
    (!out.is_empty()).then_some(out)
}

/// text を走査し、`marks`（外側から継承した文脈）付きの InlineNode 列を out へ積む。
fn parse_inline_into(text: &str, marks: &[Mark], out: &mut Vec<InlineNode>) {
    let mut plain = String::new();
    let mut i = 0;
    while i < text.len() {
        let rest = &text[i..];
        // backslash escape（ASCII 記号のみ — CommonMark と同じ）
        if let Some(next) = rest.strip_prefix('\\').and_then(|r| r.chars().next()) {
            if next.is_ascii_punctuation() {
                plain.push(next);
                i += 1 + next.len_utf8();
                continue;
            }
        }
        if let Some((nodes, consumed)) = try_construct(rest, text, i, marks) {
            flush_plain(&mut plain, marks, out);
            for node in nodes {
                push_node(out, node);
            }
            i += consumed;
            continue;
        }
        let ch = rest.chars().next().expect("rest is non-empty");
        plain.push(ch);
        i += ch.len_utf8();
    }
    flush_plain(&mut plain, marks, out);
}

fn try_construct(
    rest: &str,
    full: &str,
    offset: usize,
    marks: &[Mark],
) -> Option<(Vec<InlineNode>, usize)> {
    match rest.chars().next()? {
        '`' => code_span(rest, marks),
        '[' => note_mention(rest, marks).or_else(|| link(rest, marks)),
        '*' => emphasis(rest, "***", &[Mark::Bold, Mark::Italic], marks)
            .or_else(|| emphasis(rest, "**", &[Mark::Bold], marks))
            .or_else(|| emphasis(rest, "*", &[Mark::Italic], marks)),
        '_' => {
            // 語中の `_` は強調にしない（snake_case を守る — CommonMark と同じ扱い）
            let prev = full[..offset].chars().next_back();
            if prev.is_some_and(|c| c.is_alphanumeric()) {
                return None;
            }
            emphasis(rest, "___", &[Mark::Bold, Mark::Italic], marks)
                .or_else(|| emphasis(rest, "__", &[Mark::Bold], marks))
                .or_else(|| emphasis(rest, "_", &[Mark::Italic], marks))
        }
        '~' => emphasis(rest, "~~", &[Mark::Strike], marks)
            .or_else(|| emphasis(rest, "~", &[Mark::Strike], marks)),
        '<' => underline(rest, marks),
        _ => None,
    }
}

/// 対の delimiter で囲まれた強調。内容は非空かつ両端が空白でないこと（input rule と同じ制約）。
fn emphasis(
    rest: &str,
    delim: &str,
    added: &[Mark],
    marks: &[Mark],
) -> Option<(Vec<InlineNode>, usize)> {
    let inner_rest = rest.strip_prefix(delim)?;
    let mut from = 0;
    loop {
        let idx = inner_rest[from..].find(delim)? + from;
        if idx == 0 {
            return None;
        }
        let content = &inner_rest[..idx];
        if content.starts_with(char::is_whitespace) {
            return None;
        }
        if content.ends_with(char::is_whitespace) {
            from = idx + 1;
            continue;
        }
        let mut inner_marks = marks.to_vec();
        inner_marks.extend_from_slice(added);
        let mut nodes = Vec::new();
        parse_inline_into(content, &inner_marks, &mut nodes);
        return Some((nodes, delim.len() + idx + delim.len()));
    }
}

/// backtick run で囲まれた code span。閉じは同じ長さの run（CommonMark と同じ）。中身は素通し。
fn code_span(rest: &str, marks: &[Mark]) -> Option<(Vec<InlineNode>, usize)> {
    let n = rest.chars().take_while(|c| *c == '`').count();
    let inner_rest = &rest[n..];
    let bytes = inner_rest.as_bytes();
    let mut start = None;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'`' {
            let run_start = i;
            while i < bytes.len() && bytes[i] == b'`' {
                i += 1;
            }
            if i - run_start == n {
                start = Some(run_start);
                break;
            }
        } else {
            i += 1;
        }
    }
    let idx = start?;
    if idx == 0 {
        return None;
    }
    let mut inner_marks = marks.to_vec();
    inner_marks.push(Mark::Code);
    let node = text_node(inner_rest[..idx].to_string(), &inner_marks);
    Some((vec![node], n + idx + n))
}

/// `[[id]]` / `[[id|title]]` → noteMention。title は捨てる（表示名は NodeView が解決）。
fn note_mention(rest: &str, marks: &[Mark]) -> Option<(Vec<InlineNode>, usize)> {
    let inner = rest.strip_prefix("[[")?;
    let end = inner.find("]]")?;
    let body = &inner[..end];
    if body.is_empty() || body.contains('[') || body.contains(']') {
        return None;
    }
    let note_id = body.split_once('|').map_or(body, |(id, _)| id);
    if note_id.is_empty() || note_id.contains("#^") {
        return None;
    }
    let node = InlineNode::NoteMention {
        attrs: Some(NoteMentionAttrs { note_id: Some(note_id.to_string()), extra: Map::new() }),
        marks: marks_vec(marks),
    };
    Some((vec![node], 2 + end + 2))
}

/// href を閉じる `)` の位置。`(` を数えて釣り合いを取る — Wikipedia の
/// `.../Foo_(film)` のように href 自身が括弧を含むと、最初の `)` では切れない。
fn href_end(after: &str) -> Option<usize> {
    let mut depth = 0usize;
    for (i, ch) in after.char_indices() {
        match ch {
            '(' => depth += 1,
            ')' if depth == 0 => return Some(i),
            ')' => depth -= 1,
            _ => {}
        }
    }
    None
}

/// `[label](href)` → label に link mark を付けて再帰 parse。
fn link(rest: &str, marks: &[Mark]) -> Option<(Vec<InlineNode>, usize)> {
    let inner = rest.strip_prefix('[')?;
    let close = inner.find(']')?;
    let label = &inner[..close];
    let after = inner[close + 1..].strip_prefix('(')?;
    let paren = href_end(after)?;
    let href = &after[..paren];
    if href.is_empty() || href.contains(char::is_whitespace) {
        return None;
    }
    let mut inner_marks = marks.to_vec();
    inner_marks.push(Mark::Link {
        attrs: Some(LinkMarkAttrs { href: Some(href.to_string()), extra: Map::new() }),
    });
    let mut nodes = Vec::new();
    if label.is_empty() {
        nodes.push(text_node(href.to_string(), &inner_marks));
    } else {
        parse_inline_into(label, &inner_marks, &mut nodes);
    }
    Some((nodes, 1 + close + 2 + paren + 1))
}

fn underline(rest: &str, marks: &[Mark]) -> Option<(Vec<InlineNode>, usize)> {
    let inner = rest.strip_prefix("<u>")?;
    let end = inner.find("</u>")?;
    if end == 0 {
        return None;
    }
    let mut inner_marks = marks.to_vec();
    inner_marks.push(Mark::Underline);
    let mut nodes = Vec::new();
    parse_inline_into(&inner[..end], &inner_marks, &mut nodes);
    Some((nodes, 3 + end + 4))
}

fn flush_plain(plain: &mut String, marks: &[Mark], out: &mut Vec<InlineNode>) {
    if plain.is_empty() {
        return;
    }
    push_node(out, text_node(std::mem::take(plain), marks));
}

/// 直前と同一 marks の text 同士は結合する（`*a*b` の後半のような断片を 1 ノードに保つ）。
fn push_node(out: &mut Vec<InlineNode>, node: InlineNode) {
    if let (
        Some(InlineNode::Text { text: Some(last), marks: last_marks }),
        InlineNode::Text { text: Some(next), marks: next_marks },
    ) = (out.last_mut(), &node)
    {
        if *last_marks == *next_marks {
            last.push_str(next);
            return;
        }
    }
    out.push(node);
}

fn text_node(text: String, marks: &[Mark]) -> InlineNode {
    InlineNode::Text { text: Some(text), marks: marks_vec(marks) }
}

fn marks_vec(marks: &[Mark]) -> Option<Vec<Mark>> {
    if marks.is_empty() {
        return None;
    }
    // ProseMirror はスキーマ定義順の rank で marks を保持するので、同じ順に並べて出す。
    // 同一 mark の入れ子（`*a _b_*` など）による重複は 1 つに畳む — 重複した marks は
    // ProseMirror の Node.check() が invalid として弾く。
    let mut sorted = marks.to_vec();
    sorted.sort_by_key(mark_rank);
    sorted.dedup();
    Some(sorted)
}

fn mark_rank(mark: &Mark) -> usize {
    match mark {
        Mark::Bold => 0,
        Mark::Italic => 1,
        Mark::Underline => 2,
        Mark::Strike => 3,
        Mark::Code => 4,
        Mark::Link { .. } => 5,
        Mark::Unknown(_) => 6,
    }
}
