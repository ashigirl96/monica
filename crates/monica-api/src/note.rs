use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum EssayStatus {
    Writing,
    Finished,
}

impl From<monica_domain::EssayStatus> for EssayStatus {
    fn from(value: monica_domain::EssayStatus) -> Self {
        match value {
            monica_domain::EssayStatus::Writing => Self::Writing,
            monica_domain::EssayStatus::Finished => Self::Finished,
        }
    }
}

impl From<EssayStatus> for monica_domain::EssayStatus {
    fn from(value: EssayStatus) -> Self {
        match value {
            EssayStatus::Writing => Self::Writing,
            EssayStatus::Finished => Self::Finished,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NoteKind {
    Project {
        project_id: String,
        title: String,
    },
    Daily,
    Essay {
        title: String,
        status: EssayStatus,
        /// ⌃Q・コンテキストメニューが次に送る status（`EssayStatus::toggled` の結果）。
        /// 遷移規則を domain に閉じるため、フロントは二値判定せずこれをそのまま送る。
        next_status: EssayStatus,
    },
}

impl From<monica_domain::NoteKind> for NoteKind {
    fn from(value: monica_domain::NoteKind) -> Self {
        match value {
            monica_domain::NoteKind::Project { project_id, title } => {
                Self::Project { project_id, title }
            }
            monica_domain::NoteKind::Daily => Self::Daily,
            monica_domain::NoteKind::Essay { title, status } => Self::Essay {
                title,
                status: status.into(),
                next_status: status.toggled().into(),
            },
        }
    }
}

impl From<NoteKind> for monica_domain::NoteKind {
    fn from(value: NoteKind) -> Self {
        match value {
            NoteKind::Project { project_id, title } => Self::Project { project_id, title },
            NoteKind::Daily => Self::Daily,
            // next_status は導出値なので入力では読まない
            NoteKind::Essay { title, status, .. } => {
                Self::Essay { title, status: status.into() }
            }
        }
    }
}

/// essay status 変更リクエスト（⌃Q）。トグルではなく冪等な明示 set。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct SetEssayStatus {
    pub status: EssayStatus,
}

/// ⌥N（/projects）の新規 project note 作成リクエスト。project_id は "owner/repo" 形式で
/// スラッシュを含むため path ではなく body で渡す。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct CreateProjectNote {
    pub project_id: String,
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

/// synced block（transclusion）の解決結果。元 note の blockContainer subtree の
/// ProseMirror JSON。TS 側でも opaque に扱う。
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct NoteBlock {
    #[specta(type = specta_typescript::Unknown)]
    pub block: serde_json::Value,
}

impl From<monica_domain::RawJson> for NoteBlock {
    fn from(value: monica_domain::RawJson) -> Self {
        // store が Value::to_string() で書いた JSON なのでパースは成功する。
        // 防御的に、壊れていたら null を返す（NodeView は fromJSON 失敗を error 表示にする）。
        let block = serde_json::from_str(value.as_str()).unwrap_or(serde_json::Value::Null);
        Self { block }
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
    fn kind_mirror_roundtrips_and_only_adds_next_status() {
        let cases = [
            monica_domain::NoteKind::Project {
                project_id: "o/r".to_string(),
                title: "named".to_string(),
            },
            monica_domain::NoteKind::Daily,
            monica_domain::NoteKind::Essay {
                title: "t".to_string(),
                status: monica_domain::EssayStatus::Writing,
            },
            monica_domain::NoteKind::Essay {
                title: "done".to_string(),
                status: monica_domain::EssayStatus::Finished,
            },
        ];
        for domain in cases {
            let api: NoteKind = domain.clone().into();
            let mut api_json = serde_json::to_value(&api).unwrap();
            // next_status は DTO だけが足す導出フィールド。それを除けば domain と一字一句同じであること
            let next_status = api_json.as_object_mut().unwrap().remove("next_status");
            assert_eq!(api_json, serde_json::to_value(&domain).unwrap());
            match domain.status() {
                Some(status) => assert_eq!(
                    next_status.expect("essay には next_status が載る"),
                    serde_json::json!(status.toggled().as_str()),
                ),
                None => assert!(next_status.is_none(), "essay 以外に next_status は載らない"),
            }
            let back: monica_domain::NoteKind = api.into();
            assert_eq!(back, domain);
        }
    }

    #[test]
    fn note_block_projects_raw_json() {
        let raw = monica_domain::RawJson::from(r#"{"type":"blockContainer","attrs":{"id":"b"}}"#);
        let dto = NoteBlock::from(raw);
        assert_eq!(dto.block["attrs"]["id"], "b");

        let broken = NoteBlock::from(monica_domain::RawJson::from("not json"));
        assert_eq!(broken.block, serde_json::Value::Null);
    }
}
