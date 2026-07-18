use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NoteKind {
    Project { project_id: String },
    Daily,
    Essay { title: String },
}

impl From<monica_domain::NoteKind> for NoteKind {
    fn from(value: monica_domain::NoteKind) -> Self {
        match value {
            monica_domain::NoteKind::Project { project_id } => Self::Project { project_id },
            monica_domain::NoteKind::Daily => Self::Daily,
            monica_domain::NoteKind::Essay { title } => Self::Essay { title },
        }
    }
}

impl From<NoteKind> for monica_domain::NoteKind {
    fn from(value: NoteKind) -> Self {
        match value {
            NoteKind::Project { project_id } => Self::Project { project_id },
            NoteKind::Daily => Self::Daily,
            NoteKind::Essay { title } => Self::Essay { title },
        }
    }
}

/// kind 遷移リクエスト。Essay に title を載せない（daily → essay は常に空 title）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SetNoteKind {
    Daily,
    Essay,
    Project { project_id: String },
}

impl From<SetNoteKind> for monica_domain::NoteKindTarget {
    fn from(value: SetNoteKind) -> Self {
        match value {
            SetNoteKind::Daily => Self::Daily,
            SetNoteKind::Essay => Self::Essay,
            SetNoteKind::Project { project_id } => Self::Project { project_id },
        }
    }
}

fn content_value(content: monica_domain::RawJson) -> serde_json::Value {
    serde_json::from_str(content.as_str()).unwrap_or_else(|_| {
        serde_json::from_str(monica_domain::EMPTY_NOTE_DOC).expect("EMPTY_NOTE_DOC is valid JSON")
    })
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct Note {
    pub id: String,
    pub kind: NoteKind,
    /// ProseMirror doc。TS 側でも opaque に扱うので unknown で export する。
    #[specta(type = specta_typescript::Unknown)]
    pub content: serde_json::Value,
    pub date: String,
    pub created_at: String,
    pub updated_at: String,
}

impl From<monica_domain::Note> for Note {
    fn from(value: monica_domain::Note) -> Self {
        Self {
            id: value.id.into_string(),
            kind: value.kind.into(),
            content: content_value(value.content),
            date: value.date,
            created_at: value.created_at,
            updated_at: value.updated_at,
        }
    }
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct NoteSummary {
    pub id: String,
    pub kind: NoteKind,
    pub preview: Option<String>,
    pub date: String,
    pub created_at: String,
    pub updated_at: String,
}

impl From<monica_domain::NoteSummary> for NoteSummary {
    fn from(value: monica_domain::NoteSummary) -> Self {
        Self {
            id: value.id.into_string(),
            kind: value.kind.into(),
            preview: value.preview,
            date: value.date,
            created_at: value.created_at,
            updated_at: value.updated_at,
        }
    }
}

/// wiki link（`[[`）の検索候補・解決結果。表示名の導出規則は domain の
/// `NoteKind::display_name` にあり、フロントは受け取った文字列を表示するだけ。
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct NoteMention {
    pub id: String,
    pub display_name: String,
    /// 検索 dropdown のサブラベル。解決（単一取得）では返さない。
    pub preview: Option<String>,
}

impl From<monica_domain::NoteSummary> for NoteMention {
    fn from(value: monica_domain::NoteSummary) -> Self {
        let display_name = value.kind.display_name(&value.date);
        Self { id: value.id.into_string(), display_name, preview: value.preview }
    }
}

impl From<monica_domain::Note> for NoteMention {
    fn from(value: monica_domain::Note) -> Self {
        let display_name = value.kind.display_name(&value.date);
        Self { id: value.id.into_string(), display_name, preview: None }
    }
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct NotePage {
    pub items: Vec<NoteSummary>,
    pub has_more: bool,
}

impl From<monica_domain::NotePage> for NotePage {
    fn from(value: monica_domain::NotePage) -> Self {
        Self {
            items: value.items.into_iter().map(Into::into).collect(),
            has_more: value.has_more,
        }
    }
}

/// autosave の置換 payload。kind の変更は POST /api/notes/{id}/kind 専用で、ここには載らない。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct UpdateNote {
    /// Essay の title 全置換。null = 触らない。essay 以外の note では無視される。
    pub title: Option<String>,
    #[specta(type = specta_typescript::Unknown)]
    pub content: serde_json::Value,
}

impl From<UpdateNote> for monica_domain::UpdateNote {
    fn from(value: UpdateNote) -> Self {
        Self {
            title: value.title,
            content: monica_domain::RawJson::from(value.content.to_string()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
pub struct NotesToday {
    /// day boundary 設定を適用した logical date（`YYYY-MM-DD`）。
    pub date: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
pub struct DailyNoteCount {
    pub date: String,
    #[specta(type = specta_typescript::Number)]
    pub count: i64,
}

impl From<monica_domain::DailyNoteCount> for DailyNoteCount {
    fn from(value: monica_domain::DailyNoteCount) -> Self {
        Self { date: value.date, count: value.count }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_mirror_roundtrips_and_matches_domain_serde() {
        let cases = [
            monica_domain::NoteKind::Project { project_id: "o/r".to_string() },
            monica_domain::NoteKind::Daily,
            monica_domain::NoteKind::Essay { title: "t".to_string() },
        ];
        for domain in cases {
            let api: NoteKind = domain.clone().into();
            assert_eq!(
                serde_json::to_string(&api).unwrap(),
                serde_json::to_string(&domain).unwrap(),
            );
            let back: monica_domain::NoteKind = api.into();
            assert_eq!(back, domain);
        }
    }

    #[test]
    fn set_note_kind_maps_to_domain_target() {
        assert_eq!(
            monica_domain::NoteKindTarget::from(SetNoteKind::Daily),
            monica_domain::NoteKindTarget::Daily
        );
        assert_eq!(
            monica_domain::NoteKindTarget::from(SetNoteKind::Essay),
            monica_domain::NoteKindTarget::Essay
        );
        assert_eq!(
            monica_domain::NoteKindTarget::from(SetNoteKind::Project {
                project_id: "o/r".to_string()
            }),
            monica_domain::NoteKindTarget::Project { project_id: "o/r".to_string() }
        );
    }
}
