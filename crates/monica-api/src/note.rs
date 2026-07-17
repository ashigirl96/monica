use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum NoteKind {
    Essay,
    Journaling,
    Memo,
}

impl From<monica_domain::NoteKind> for NoteKind {
    fn from(value: monica_domain::NoteKind) -> Self {
        match value {
            monica_domain::NoteKind::Essay => Self::Essay,
            monica_domain::NoteKind::Journaling => Self::Journaling,
            monica_domain::NoteKind::Memo => Self::Memo,
        }
    }
}

impl From<NoteKind> for monica_domain::NoteKind {
    fn from(value: NoteKind) -> Self {
        match value {
            NoteKind::Essay => Self::Essay,
            NoteKind::Journaling => Self::Journaling,
            NoteKind::Memo => Self::Memo,
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
    pub title: Option<String>,
    pub kind: NoteKind,
    pub project_id: Option<String>,
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
            title: value.title,
            kind: value.kind.into(),
            project_id: value.project_id,
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
    pub title: Option<String>,
    pub kind: NoteKind,
    pub project_id: Option<String>,
    pub preview: Option<String>,
    pub date: String,
    pub created_at: String,
    pub updated_at: String,
}

impl From<monica_domain::NoteSummary> for NoteSummary {
    fn from(value: monica_domain::NoteSummary) -> Self {
        Self {
            id: value.id.into_string(),
            title: value.title,
            kind: value.kind.into(),
            project_id: value.project_id,
            preview: value.preview,
            date: value.date,
            created_at: value.created_at,
            updated_at: value.updated_at,
        }
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

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct UpdateNote {
    pub title: Option<String>,
    pub kind: NoteKind,
    pub project_id: Option<String>,
    #[specta(type = specta_typescript::Unknown)]
    pub content: serde_json::Value,
}

impl From<UpdateNote> for monica_domain::UpdateNote {
    fn from(value: UpdateNote) -> Self {
        Self {
            title: value.title,
            kind: value.kind.into(),
            project_id: value.project_id,
            content: monica_domain::RawJson::from(value.content.to_string()),
        }
    }
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
