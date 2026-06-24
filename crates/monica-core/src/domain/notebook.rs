//! Pure notebook domain logic. Must stay fs-independent so the heavy CLI-only lint
//! dependencies never reach the crates that depend on this one.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct NotebookPage {
    pub id: String,
    pub title: String,
    #[cfg_attr(feature = "specta", specta(type = specta_typescript::Number))]
    pub order: i32,
    pub parent_id: Option<String>,
}

/// `front` values are kept as raw strings (not typed) so the linter can report every
/// malformed field instead of failing fast on the first one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotebookDoc {
    pub file: String,
    pub stem: String,
    pub front: Vec<(String, String)>,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LintFinding {
    pub file: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutlineEntry {
    pub number: String,
    pub id: String,
    pub title: String,
}

/// `^[a-z0-9]+(-[a-z0-9]+)*$` — ASCII-lowercase kebab-case.
pub fn is_valid_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug
            .split('-')
            .all(|seg| !seg.is_empty() && seg.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()))
}

/// BOM/CRLF tolerant. With no leading `---`, the whole input is returned as the body.
pub fn parse_front_matter(content: &str) -> Result<(Vec<(String, String)>, String), String> {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let mut front = Vec::new();
    let mut cursor = 0usize;
    let mut first = true;
    loop {
        let rest = &content[cursor..];
        let (line, next_cursor, had_nl) = match rest.find('\n') {
            Some(i) => (&rest[..i], cursor + i + 1, true),
            None => (rest, content.len(), false),
        };
        let logical = line.strip_suffix('\r').unwrap_or(line);
        let trimmed = logical.trim_end();

        if first {
            if trimmed != "---" {
                return Ok((Vec::new(), content.to_string()));
            }
        } else if trimmed == "---" {
            let body = if had_nl {
                content[next_cursor..].to_string()
            } else {
                String::new()
            };
            return Ok((front, body));
        } else if let Some(pair) = parse_front_line(logical) {
            front.push(pair);
        }

        if !had_nl {
            break;
        }
        cursor = next_cursor;
        first = false;
    }
    Err("unterminated front matter: missing closing `---`".to_string())
}

fn parse_front_line(line: &str) -> Option<(String, String)> {
    let (key, value) = line.split_once(':')?;
    let key = key.trim();
    if key.is_empty() {
        return None;
    }
    Some((key.to_string(), unquote(value.trim()).to_string()))
}

fn unquote(s: &str) -> &str {
    let bytes = s.as_bytes();
    if bytes.len() >= 2 {
        let (first, last) = (bytes[0], bytes[bytes.len() - 1]);
        if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
            return &s[1..s.len() - 1];
        }
    }
    s
}

pub fn parse_wikilink(s: &str) -> Option<String> {
    let inner = s.trim().strip_prefix("[[")?.strip_suffix("]]")?;
    let stem = inner.strip_suffix(".md").unwrap_or(inner).trim();
    (!stem.is_empty()).then(|| stem.to_string())
}

pub fn mermaid_blocks(body: &str) -> Vec<String> {
    let mut blocks = Vec::new();
    let mut lines = body.lines();
    while let Some(line) = lines.next() {
        let opener = line.trim();
        if opener.strip_prefix("```").map(str::trim) == Some("mermaid") {
            let mut block = String::new();
            for inner in lines.by_ref() {
                if inner.trim().starts_with("```") {
                    break;
                }
                block.push_str(inner);
                block.push('\n');
            }
            blocks.push(block.trim().to_string());
        }
    }
    blocks
}

/// Pure: mermaid and markdown-style checks live in the CLI, not here.
pub fn structural_lint(docs: &[NotebookDoc]) -> Vec<LintFinding> {
    let stems: HashSet<&str> = docs.iter().map(|d| d.stem.as_str()).collect();
    let mut findings = Vec::new();

    for doc in docs {
        let title = front_get(doc, "title");
        let order = front_get(doc, "order");
        let created = front_get(doc, "created");

        for (key, value) in [("title", title), ("order", order), ("created", created)] {
            if value.is_none() {
                findings.push(finding(doc, format!("missing required front matter key `{key}`")));
            }
        }
        for (key, value) in [("title", title), ("created", created)] {
            if matches!(value, Some(v) if v.trim().is_empty()) {
                findings.push(finding(doc, format!("front matter key `{key}` must not be empty")));
            }
        }
        if let Some(v) = order.map(str::trim) {
            if !matches!(v.parse::<i64>(), Ok(n) if n > 0) {
                findings.push(finding(doc, format!("`order` must be a positive integer, got `{v}`")));
            }
        }
        if let Some(p) = front_get(doc, "parent").map(str::trim).filter(|p| !p.is_empty()) {
            match parse_wikilink(p) {
                None => findings.push(finding(
                    doc,
                    format!("`parent` must be a wikilink like `[[step-1.md]]`, got `{p}`"),
                )),
                Some(stem) if !stems.contains(stem.as_str()) => findings.push(finding(
                    doc,
                    format!("`parent` references `{stem}` which does not exist"),
                )),
                Some(_) => {}
            }
        }
    }

    findings.extend(cycle_findings(docs, &stems));
    findings
}

/// Empty or dangling `parent` links resolve to a root (`parent_id == None`).
pub fn pages_from_docs(docs: &[NotebookDoc]) -> Vec<NotebookPage> {
    let stems: HashSet<&str> = docs.iter().map(|d| d.stem.as_str()).collect();
    let mut pages: Vec<NotebookPage> = docs
        .iter()
        .map(|doc| NotebookPage {
            id: doc.stem.clone(),
            title: front_get(doc, "title").unwrap_or("").trim().to_string(),
            order: front_get(doc, "order")
                .and_then(|v| v.trim().parse::<i32>().ok())
                .unwrap_or(0),
            parent_id: resolve_parent(doc, &stems),
        })
        .collect();
    pages.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.id.cmp(&b.id)));
    pages
}

/// Pages unreachable from a root (e.g. caught in a `parent` cycle) are omitted.
pub fn outline(pages: &[NotebookPage]) -> Vec<OutlineEntry> {
    let mut children: HashMap<Option<&str>, Vec<&NotebookPage>> = HashMap::new();
    for p in pages {
        children.entry(p.parent_id.as_deref()).or_default().push(p);
    }
    for kids in children.values_mut() {
        kids.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.id.cmp(&b.id)));
    }
    let mut out = Vec::new();
    push_outline(None, "", &children, &mut out);
    out
}

fn push_outline(
    parent: Option<&str>,
    prefix: &str,
    children: &HashMap<Option<&str>, Vec<&NotebookPage>>,
    out: &mut Vec<OutlineEntry>,
) {
    let Some(kids) = children.get(&parent) else {
        return;
    };
    for (i, page) in kids.iter().enumerate() {
        let number = if prefix.is_empty() {
            (i + 1).to_string()
        } else {
            format!("{prefix}.{}", i + 1)
        };
        out.push(OutlineEntry {
            number: number.clone(),
            id: page.id.clone(),
            title: page.title.clone(),
        });
        push_outline(Some(page.id.as_str()), &number, children, out);
    }
}

fn cycle_findings(docs: &[NotebookDoc], stems: &HashSet<&str>) -> Vec<LintFinding> {
    let mut parent: HashMap<&str, String> = HashMap::new();
    for doc in docs {
        if let Some(pstem) = resolve_parent(doc, stems) {
            parent.insert(doc.stem.as_str(), pstem);
        }
    }
    let n = docs.len();
    docs.iter()
        .filter(|doc| node_in_cycle(doc.stem.as_str(), &parent, n))
        .map(|doc| finding(doc, format!("`parent` chain forms a cycle at `{}`", doc.stem)))
        .collect()
}

/// True iff following `parent` pointers from `start` returns to `start` within `n` hops,
/// i.e. `start` lies *on* a cycle (not merely leads into one).
fn node_in_cycle(start: &str, parent: &HashMap<&str, String>, n: usize) -> bool {
    let mut cur = start;
    for _ in 0..=n {
        match parent.get(cur) {
            Some(p) => {
                cur = p.as_str();
                if cur == start {
                    return true;
                }
            }
            None => return false,
        }
    }
    false
}

/// Resolve a page's `parent` link to an existing stem; empty, malformed, or dangling links → `None`.
fn resolve_parent(doc: &NotebookDoc, stems: &HashSet<&str>) -> Option<String> {
    front_get(doc, "parent")
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .and_then(parse_wikilink)
        .filter(|stem| stems.contains(stem.as_str()))
}

fn front_get<'a>(doc: &'a NotebookDoc, key: &str) -> Option<&'a str> {
    doc.front
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.as_str())
}

fn finding(doc: &NotebookDoc, message: String) -> LintFinding {
    LintFinding {
        file: doc.file.clone(),
        message,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(file: &str, front: &[(&str, &str)], body: &str) -> NotebookDoc {
        NotebookDoc {
            file: file.to_string(),
            stem: file.strip_suffix(".md").unwrap_or(file).to_string(),
            front: front
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            body: body.to_string(),
        }
    }

    fn messages(findings: &[LintFinding]) -> String {
        findings
            .iter()
            .map(|f| format!("{}: {}", f.file, f.message))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn is_valid_slug_accepts_kebab_rejects_others() {
        for ok in ["step-by-step", "a", "a1", "step-1", "0"] {
            assert!(is_valid_slug(ok), "{ok}");
        }
        for bad in ["", "-a", "a-", "a--b", "Step", "step_1", "step 1", "解説", "a-B"] {
            assert!(!is_valid_slug(bad), "{bad}");
        }
    }

    #[test]
    fn parse_front_matter_basic_with_quotes_and_first_colon() {
        let input = "---\ntitle: \"Step 1: 概要\"\norder: 1\nparent:\ncreated: 2026-06-25T10:00:00Z\n---\nbody line\n";
        let (front, body) = parse_front_matter(input).unwrap();
        assert_eq!(
            front,
            vec![
                ("title".into(), "Step 1: 概要".into()),
                ("order".into(), "1".into()),
                ("parent".into(), "".into()),
                ("created".into(), "2026-06-25T10:00:00Z".into()),
            ]
        );
        assert_eq!(body, "body line\n");
    }

    #[test]
    fn parse_front_matter_strips_single_quotes() {
        let (front, _) = parse_front_matter("---\ntitle: 'hello world'\n---\n").unwrap();
        assert_eq!(front, vec![("title".into(), "hello world".into())]);
    }

    #[test]
    fn parse_front_matter_closing_fence_without_trailing_newline() {
        let (front, body) = parse_front_matter("---\ntitle: A\n---").unwrap();
        assert_eq!(front, vec![("title".into(), "A".into())]);
        assert_eq!(body, "");
    }

    #[test]
    fn parse_front_matter_tolerates_bom_and_crlf() {
        let input = "\u{feff}---\r\ntitle: A\r\n---\r\nbody\r\n";
        let (front, body) = parse_front_matter(input).unwrap();
        assert_eq!(front, vec![("title".into(), "A".into())]);
        assert_eq!(body, "body\r\n");
    }

    #[test]
    fn parse_front_matter_without_leading_fence_is_all_body() {
        let input = "no front matter\nsecond line\n";
        let (front, body) = parse_front_matter(input).unwrap();
        assert!(front.is_empty());
        assert_eq!(body, input);
    }

    #[test]
    fn parse_front_matter_unterminated_errors() {
        assert!(parse_front_matter("---\ntitle: A\n").is_err());
    }

    #[test]
    fn parse_wikilink_variants() {
        assert_eq!(parse_wikilink("[[step-1.md]]"), Some("step-1".into()));
        assert_eq!(parse_wikilink("  [[step-2]]  "), Some("step-2".into()));
        assert_eq!(parse_wikilink("step-1.md"), None);
        assert_eq!(parse_wikilink("[[]]"), None);
        assert_eq!(parse_wikilink(""), None);
    }

    #[test]
    fn mermaid_blocks_extracts_zero_and_many() {
        assert!(mermaid_blocks("no fences here").is_empty());
        let body = "intro\n```mermaid\ngraph TD\nA-->B\n```\nmid\n```rust\nlet x = 1;\n```\n```mermaid\nflowchart LR\nC-->D\n```\n";
        let blocks = mermaid_blocks(body);
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0], "graph TD\nA-->B");
        assert_eq!(blocks[1], "flowchart LR\nC-->D");
    }

    #[test]
    fn structural_lint_passes_valid_tree() {
        let docs = [
            doc(
                "step-1.md",
                &[
                    ("title", "Overview"),
                    ("order", "1"),
                    ("parent", ""),
                    ("created", "2026-06-25T10:00:00Z"),
                ],
                "",
            ),
            doc(
                "step-1-q1.md",
                &[
                    ("title", "Question"),
                    ("order", "1"),
                    ("parent", "[[step-1.md]]"),
                    ("created", "2026-06-25T10:01:00Z"),
                ],
                "",
            ),
        ];
        assert!(structural_lint(&docs).is_empty(), "{}", messages(&structural_lint(&docs)));
    }

    #[test]
    fn structural_lint_flags_each_rule() {
        let missing = doc("a.md", &[("order", "1"), ("parent", "")], "");
        assert!(messages(&structural_lint(&[missing])).contains("missing required front matter key `title`"));

        let empty_title = doc(
            "a.md",
            &[("title", "  "), ("order", "1"), ("created", "x")],
            "",
        );
        assert!(messages(&structural_lint(&[empty_title])).contains("`title` must not be empty"));

        let bad_order = doc(
            "a.md",
            &[("title", "t"), ("order", "0"), ("created", "x")],
            "",
        );
        assert!(messages(&structural_lint(&[bad_order])).contains("`order` must be a positive integer"));

        let dangling = doc(
            "a.md",
            &[
                ("title", "t"),
                ("order", "1"),
                ("parent", "[[nope.md]]"),
                ("created", "x"),
            ],
            "",
        );
        assert!(messages(&structural_lint(&[dangling])).contains("references `nope` which does not exist"));

        let bad_parent = doc(
            "a.md",
            &[
                ("title", "t"),
                ("order", "1"),
                ("parent", "step-1"),
                ("created", "x"),
            ],
            "",
        );
        assert!(messages(&structural_lint(&[bad_parent])).contains("must be a wikilink"));
    }

    #[test]
    fn structural_lint_flags_empty_created_and_bad_order_values() {
        let empty_created = doc(
            "a.md",
            &[("title", "t"), ("order", "1"), ("created", "  ")],
            "",
        );
        assert!(messages(&structural_lint(&[empty_created])).contains("`created` must not be empty"));

        for bad in ["-1", "abc", "1.5"] {
            let d = doc("a.md", &[("title", "t"), ("order", bad), ("created", "x")], "");
            assert!(
                messages(&structural_lint(&[d])).contains("`order` must be a positive integer"),
                "order={bad}"
            );
        }
    }

    #[test]
    fn structural_lint_detects_cycle() {
        let docs = [
            doc(
                "a.md",
                &[
                    ("title", "A"),
                    ("order", "1"),
                    ("parent", "[[b.md]]"),
                    ("created", "x"),
                ],
                "",
            ),
            doc(
                "b.md",
                &[
                    ("title", "B"),
                    ("order", "1"),
                    ("parent", "[[a.md]]"),
                    ("created", "x"),
                ],
                "",
            ),
        ];
        let out = messages(&structural_lint(&docs));
        assert!(out.contains("cycle at `a`"), "{out}");
        assert!(out.contains("cycle at `b`"), "{out}");
    }

    #[test]
    fn pages_from_docs_resolves_parents_and_sorts() {
        let docs = [
            doc("step-2.md", &[("title", "Two"), ("order", "2"), ("parent", "")], ""),
            doc(
                "step-1-q1.md",
                &[("title", "Q"), ("order", "1"), ("parent", "[[step-1.md]]")],
                "",
            ),
            doc("step-1.md", &[("title", "One"), ("order", "1"), ("parent", "")], ""),
            doc(
                "orphan.md",
                &[("title", "Orphan"), ("order", "3"), ("parent", "[[gone.md]]")],
                "",
            ),
        ];
        let pages = pages_from_docs(&docs);
        let by_id = |id: &str| pages.iter().find(|p| p.id == id).unwrap();
        assert_eq!(by_id("step-1").parent_id, None);
        assert_eq!(by_id("step-1-q1").parent_id, Some("step-1".into()));
        assert_eq!(by_id("orphan").parent_id, None); // dangling parent → root
        // sorted by order then id
        let ids: Vec<&str> = pages.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, vec!["step-1", "step-1-q1", "step-2", "orphan"]);
    }

    #[test]
    fn pages_from_docs_breaks_order_ties_by_id() {
        let docs = [
            doc("b-page.md", &[("title", "B"), ("order", "1"), ("parent", "")], ""),
            doc("a-page.md", &[("title", "A"), ("order", "1"), ("parent", "")], ""),
        ];
        let ids: Vec<String> = pages_from_docs(&docs).into_iter().map(|p| p.id).collect();
        assert_eq!(ids, vec!["a-page", "b-page"]);
    }

    #[test]
    fn outline_omits_cycle_trapped_pages() {
        let pages = vec![
            NotebookPage { id: "root".into(), title: "Root".into(), order: 1, parent_id: None },
            NotebookPage { id: "a".into(), title: "A".into(), order: 2, parent_id: Some("b".into()) },
            NotebookPage { id: "b".into(), title: "B".into(), order: 3, parent_id: Some("a".into()) },
        ];
        let ids: Vec<String> = outline(&pages).into_iter().map(|e| e.id).collect();
        assert_eq!(ids, vec!["root"]);
    }

    #[test]
    fn outline_numbers_nested_tree() {
        let pages = vec![
            NotebookPage { id: "s1".into(), title: "One".into(), order: 1, parent_id: None },
            NotebookPage { id: "s1a".into(), title: "One-A".into(), order: 1, parent_id: Some("s1".into()) },
            NotebookPage { id: "s1b".into(), title: "One-B".into(), order: 2, parent_id: Some("s1".into()) },
            NotebookPage { id: "s1b1".into(), title: "One-B-1".into(), order: 1, parent_id: Some("s1b".into()) },
            NotebookPage { id: "s2".into(), title: "Two".into(), order: 2, parent_id: None },
        ];
        let entries = outline(&pages);
        let numbers: Vec<(&str, &str)> = entries
            .iter()
            .map(|e| (e.number.as_str(), e.id.as_str()))
            .collect();
        assert_eq!(
            numbers,
            vec![
                ("1", "s1"),
                ("1.1", "s1a"),
                ("1.2", "s1b"),
                ("1.2.1", "s1b1"),
                ("2", "s2"),
            ]
        );
    }
}
