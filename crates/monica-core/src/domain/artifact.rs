use serde::{Deserialize, Serialize};

#[derive(
    Debug,
    Clone,
    Copy,
    PartialEq,
    Eq,
    Serialize,
    Deserialize,
    strum::IntoStaticStr,
    strum::EnumString,
)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum ArtifactState {
    Draft,
    Saved,
}

impl ArtifactState {
    pub fn as_str(self) -> &'static str {
        self.into()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ArtifactKind {
    Memo,
    Essay {
        title: String,
    },
    Intent {
        title: String,
        project_id: Option<String>,
    },
}

impl ArtifactKind {
    pub fn kind_str(&self) -> &'static str {
        match self {
            ArtifactKind::Memo => "memo",
            ArtifactKind::Essay { .. } => "essay",
            ArtifactKind::Intent { .. } => "intent",
        }
    }

    pub fn title(&self) -> Option<&str> {
        match self {
            ArtifactKind::Memo => None,
            ArtifactKind::Essay { title } | ArtifactKind::Intent { title, .. } => Some(title),
        }
    }

    pub fn project_id(&self) -> Option<&str> {
        match self {
            ArtifactKind::Intent { project_id, .. } => project_id.as_deref(),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ArtifactDraftKind {
    Memo,
    Essay {
        title: Option<String>,
    },
    Intent {
        title: Option<String>,
        project_id: Option<String>,
    },
}

impl ArtifactDraftKind {
    pub fn kind_str(&self) -> &'static str {
        match self {
            ArtifactDraftKind::Memo => "memo",
            ArtifactDraftKind::Essay { .. } => "essay",
            ArtifactDraftKind::Intent { .. } => "intent",
        }
    }

    pub fn title(&self) -> Option<&str> {
        match self {
            ArtifactDraftKind::Memo => None,
            ArtifactDraftKind::Essay { title } | ArtifactDraftKind::Intent { title, .. } => {
                title.as_deref()
            }
        }
    }

    pub fn project_id(&self) -> Option<&str> {
        match self {
            ArtifactDraftKind::Intent { project_id, .. } => project_id.as_deref(),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Artifact {
    pub id: String,
    pub kind: ArtifactKind,
    pub body: String,
    pub occurred_at: Option<String>,
    pub attachments: Vec<Attachment>,
    #[cfg_attr(feature = "specta", specta(type = specta_typescript::Number))]
    pub revision: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ArtifactDraft {
    pub id: String,
    pub kind: ArtifactDraftKind,
    pub body: String,
    pub occurred_at: Option<String>,
    pub attachments: Vec<Attachment>,
    #[cfg_attr(feature = "specta", specta(type = specta_typescript::Number))]
    pub revision: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Attachment {
    pub id: String,
    pub entry_id: String,
    pub original_file_name: String,
    pub mime_type: Option<String>,
    #[cfg_attr(feature = "specta", specta(type = specta_typescript::Number))]
    pub byte_size: i64,
    pub relative_path: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct EssayListItem {
    pub id: String,
    pub title: String,
    pub body_preview: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct IntentListItem {
    pub id: String,
    pub title: String,
    pub body_preview: String,
    pub project_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct IntentGroup {
    pub project_id: Option<String>,
    pub items: Vec<IntentListItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TimelineItem {
    Artifact {
        entry_id: String,
        artifact_kind: String,
        title: Option<String>,
        body_preview: String,
        timeline_at: String,
        item_key: String,
    },
    TaskCreated {
        task_id: String,
        title: String,
        timeline_at: String,
        item_key: String,
    },
    TaskClosed {
        task_id: String,
        title: String,
        timeline_at: String,
        item_key: String,
    },
}

impl TimelineItem {
    pub fn timeline_at(&self) -> &str {
        match self {
            TimelineItem::Artifact { timeline_at, .. }
            | TimelineItem::TaskCreated { timeline_at, .. }
            | TimelineItem::TaskClosed { timeline_at, .. } => timeline_at,
        }
    }

    pub fn item_key(&self) -> &str {
        match self {
            TimelineItem::Artifact { item_key, .. }
            | TimelineItem::TaskCreated { item_key, .. }
            | TimelineItem::TaskClosed { item_key, .. } => item_key,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct TimelineCursor {
    pub timeline_at: String,
    pub item_key: String,
}

#[derive(Debug, Clone)]
pub struct NewDraft {
    pub kind: ArtifactDraftKind,
    pub body: String,
    pub occurred_at: Option<String>,
}

#[derive(Debug, Clone)]
pub struct NewArtifact {
    pub kind: ArtifactKind,
    pub body: String,
    pub occurred_at: Option<String>,
}
