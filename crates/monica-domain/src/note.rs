use serde::{Deserialize, Serialize};

use crate::ids::NoteId;
use crate::json::RawJson;

/// 空ノートの正規形。block editor の schema（doc → blockGroup → blockContainer → paragraph）を
/// 満たす最小の doc。schema 違反の `{"type":"doc","content":[]}` を空の意味で使うと、
/// エディタ側の破損フォールバックと区別できなくなるため、空は必ずこの形で表す。
pub const EMPTY_NOTE_DOC: &str = r#"{"type":"doc","content":[{"type":"blockGroup","content":[{"type":"blockContainer","content":[{"type":"paragraph"}]}]}]}"#;

#[derive(
    Debug,
    Clone,
    Copy,
    Default,
    PartialEq,
    Eq,
    Serialize,
    Deserialize,
    strum::IntoStaticStr,
    strum::EnumString,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum NoteKind {
    Essay,
    Journaling,
    #[default]
    Memo,
}

impl NoteKind {
    pub fn as_str(self) -> &'static str {
        self.into()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Note {
    pub id: NoteId,
    pub title: Option<String>,
    pub kind: NoteKind,
    pub project_id: Option<String>,
    /// ProseMirror doc JSON — opaque to the domain.
    pub content: RawJson,
    /// Local date (`YYYY-MM-DD`) fixed at creation; day grouping and counts key off this.
    pub date: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NoteSummary {
    pub id: NoteId,
    pub title: Option<String>,
    pub kind: NoteKind,
    pub project_id: Option<String>,
    /// First non-empty line of the content, derived by the store.
    pub preview: Option<String>,
    pub date: String,
    pub created_at: String,
    pub updated_at: String,
}

/// One page of a project-filtered note list.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NotePage {
    pub items: Vec<NoteSummary>,
    pub has_more: bool,
}

impl NotePage {
    /// `page_size + 1` 件 overfetch した結果から has_more を導出する。
    /// COUNT(*) を別クエリで走らせずに「次のページがあるか」だけを知るための定石。
    pub fn from_overfetch(mut items: Vec<NoteSummary>, page_size: usize) -> Self {
        let has_more = items.len() > page_size;
        items.truncate(page_size);
        Self { items, has_more }
    }
}

/// Full-replace payload for the autosave path.
#[derive(Debug, Clone)]
pub struct UpdateNote {
    pub title: Option<String>,
    pub kind: NoteKind,
    pub project_id: Option<String>,
    pub content: RawJson,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DailyNoteCount {
    pub date: String,
    pub count: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_round_trip() {
        for kind in [NoteKind::Essay, NoteKind::Journaling, NoteKind::Memo] {
            let s = kind.as_str();
            let parsed: NoteKind = s.parse().unwrap();
            assert_eq!(parsed, kind);
        }
    }

    #[test]
    fn kind_parse_invalid() {
        assert!("invalid".parse::<NoteKind>().is_err());
    }

    #[test]
    fn kind_default_is_memo() {
        assert_eq!(NoteKind::default(), NoteKind::Memo);
    }

    fn summary(id: &str) -> NoteSummary {
        NoteSummary {
            id: NoteId::from_store(id.to_string()),
            title: None,
            kind: NoteKind::Memo,
            project_id: None,
            preview: None,
            date: "2026-07-18".to_string(),
            created_at: "2026-07-18T00:00:00.000Z".to_string(),
            updated_at: "2026-07-18T00:00:00.000Z".to_string(),
        }
    }

    #[test]
    fn page_from_overfetch_truncates_and_flags_more() {
        let items = vec![summary("note-1"), summary("note-2"), summary("note-3")];
        let page = NotePage::from_overfetch(items, 2);
        assert!(page.has_more);
        assert_eq!(
            page.items.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
            vec!["note-1", "note-2"]
        );
    }

    #[test]
    fn page_from_overfetch_exact_page_has_no_more() {
        let page = NotePage::from_overfetch(vec![summary("note-1"), summary("note-2")], 2);
        assert!(!page.has_more);
        assert_eq!(page.items.len(), 2);
    }

    #[test]
    fn page_from_overfetch_empty() {
        let page = NotePage::from_overfetch(vec![], 2);
        assert!(!page.has_more);
        assert!(page.items.is_empty());
    }
}
