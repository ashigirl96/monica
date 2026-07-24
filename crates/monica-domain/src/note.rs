use serde::{Deserialize, Serialize};

use crate::ids::NoteId;
use crate::json::RawJson;

/// 空ノートの正規形。block editor の schema（doc → blockGroup → blockContainer → paragraph）を
/// 満たす最小の doc。schema 違反の `{"type":"doc","content":[]}` を空の意味で使うと、
/// エディタ側の破損フォールバックと区別できなくなるため、空は必ずこの形で表す。
pub const EMPTY_NOTE_DOC: &str = r#"{"type":"doc","content":[{"type":"blockGroup","content":[{"type":"blockContainer","content":[{"type":"paragraph"}]}]}]}"#;

/// essay の執筆状態。writing が既定で、DB の status 列は NULL = writing と
/// 読み替える（v42 は backfill しない — frozen migration にデータ変換を書かない）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EssayStatus {
    #[default]
    Writing,
    Finished,
}

impl EssayStatus {
    /// DB の status 列値。
    pub fn as_str(self) -> &'static str {
        match self {
            EssayStatus::Writing => "writing",
            EssayStatus::Finished => "finished",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "writing" => Some(EssayStatus::Writing),
            "finished" => Some(EssayStatus::Finished),
            _ => None,
        }
    }
}

/// note の「取り出し方」による分類。分類の軸が取り出し経路（project 経由 /
/// カレンダー・今日経由 / タイトル一覧経由）なので重複がなく、title / project_id /
/// status の不変条件（project は project_id 必須、daily は title を持たない、
/// status は essay のみ）を型で強制する。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NoteKind {
    /// project に紐づけて取り出す note。空文字 title は「無題」（書き殴りのまま）。
    Project {
        project_id: String,
        #[serde(default)]
        title: String,
    },
    /// その日の logical date に属する inbox。title を持たない。1日複数可。
    #[default]
    Daily,
    /// タイトル一覧から取り出す成果物。空文字は「無題」として許容する。
    Essay {
        title: String,
        #[serde(default)]
        status: EssayStatus,
    },
}

impl NoteKind {
    /// DB の kind 列・エラーメッセージ用の識別子。
    pub fn name(&self) -> &'static str {
        match self {
            NoteKind::Project { .. } => "project",
            NoteKind::Daily => "daily",
            NoteKind::Essay { .. } => "essay",
        }
    }

    /// title 列に永続化する値。project も同じ title 列を流用するため Some を返す
    /// （store の `set_note_kind` が `kind.title()` を書く単一経路であることに依存）。
    pub fn title(&self) -> Option<&str> {
        match self {
            NoteKind::Essay { title, .. } | NoteKind::Project { title, .. } => Some(title),
            NoteKind::Daily => None,
        }
    }

    pub fn status(&self) -> Option<EssayStatus> {
        match self {
            NoteKind::Essay { status, .. } => Some(*status),
            _ => None,
        }
    }

    pub fn project_id(&self) -> Option<&str> {
        match self {
            NoteKind::Project { project_id, .. } => Some(project_id),
            _ => None,
        }
    }

    /// mention（wiki link）の表示名。検索と解決で共有する唯一の導出規則。
    /// daily は ISO 日付をそのまま返す — 曜日等の整形はロケール依存の presentation
    /// なのでここでは持たない。
    pub fn display_name(&self, date: &str) -> String {
        match self {
            NoteKind::Essay { title, .. } if !title.is_empty() => title.clone(),
            NoteKind::Essay { .. } => "Untitled".to_string(),
            NoteKind::Daily => date.to_string(),
            NoteKind::Project { project_id, .. } => project_id.clone(),
        }
    }

    /// kind 遷移規則の唯一の定義。遷移グラフは daily を中心とした星型:
    /// daily ↔ essay（essay 化は常に空 title、daily 化は title 破棄）、
    /// daily → project は無損失の「確定」昇格。project からの脱出経路
    /// （project 付け替え含む）と essay → project 直行は設けない。
    /// 同一 kind への遷移も Err（essay → essay を許すと title 破棄事故になる）。
    pub fn transition_to(&self, target: NoteKindTarget) -> Result<NoteKind, KindTransitionError> {
        match (self, target) {
            (NoteKind::Daily, NoteKindTarget::Essay) => {
                Ok(NoteKind::Essay { title: String::new(), status: EssayStatus::Writing })
            }
            (NoteKind::Daily, NoteKindTarget::Project { project_id }) => {
                Ok(NoteKind::Project { project_id, title: String::new() })
            }
            (NoteKind::Essay { .. }, NoteKindTarget::Daily) => Ok(NoteKind::Daily),
            (from, target) => {
                Err(KindTransitionError { from: from.name(), to: target.name() })
            }
        }
    }

    /// essay の status だけを差し替えた kind を返す。kind 遷移（`transition_to`）とは
    /// 直交する操作で、title は温存し、同値への set も Ok（冪等）。essay 以外は Err。
    pub fn with_status(&self, status: EssayStatus) -> Result<NoteKind, EssayStatusError> {
        match self {
            NoteKind::Essay { title, .. } => {
                Ok(NoteKind::Essay { title: title.clone(), status })
            }
            other => Err(EssayStatusError { kind: other.name() }),
        }
    }
}

/// kind 遷移のリクエスト。Essay に title を載せない（daily → essay は常に空 title で
/// 生まれ、title の編集は autosave の担当）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NoteKindTarget {
    Daily,
    Essay,
    Project { project_id: String },
}

impl NoteKindTarget {
    pub fn name(&self) -> &'static str {
        match self {
            NoteKindTarget::Daily => "daily",
            NoteKindTarget::Essay => "essay",
            NoteKindTarget::Project { .. } => "project",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KindTransitionError {
    pub from: &'static str,
    pub to: &'static str,
}

impl std::fmt::Display for KindTransitionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "cannot change note kind: {} -> {}", self.from, self.to)
    }
}

impl std::error::Error for KindTransitionError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EssayStatusError {
    pub kind: &'static str,
}

impl std::fmt::Display for EssayStatusError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "cannot set essay status on {} note", self.kind)
    }
}

impl std::error::Error for EssayStatusError {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Note {
    pub id: NoteId,
    pub kind: NoteKind,
    /// ProseMirror doc JSON — opaque to the domain.
    pub content: RawJson,
    /// Logical date (`YYYY-MM-DD`) fixed at creation; day grouping and counts key off this.
    /// day boundary 設定の変更は過去の note に遡及しない。
    pub date: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NoteSummary {
    pub id: NoteId,
    pub kind: NoteKind,
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

/// autosave の置換 payload。kind の変更は載らない（遷移は専用コマンドの担当で、
/// in-flight の autosave が kind を巻き戻せない構造にする）。
#[derive(Debug, Clone)]
pub struct UpdateNote {
    /// Essay の title 全置換。None = 触らない。essay 以外の note では常に無視される。
    /// None-keeps にするのは、kind 遷移直後に着弾する stale な autosave が
    /// title を巻き戻さないための保険。
    pub title: Option<String>,
    pub content: RawJson,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DailyNoteCount {
    pub date: String,
    pub count: i64,
}

/// SQLite localtime 文字列（`YYYY-MM-DDTHH:MM:SS`）と day boundary から logical date を返す。
/// boundary 前の時刻（例: boundary 5 の深夜 3 時）は前日に帰属する。
/// タイムゾーン解決は SQLite の `localtime` に一任し、ここは境界シフトだけを担う —
/// 既存の date 列がすべて SQLite localtime 由来なので、時差ルールを二重化しない。
pub fn logical_date(local_now: &str, day_boundary_hour: u8) -> Option<String> {
    let (date, time) = local_now.split_once('T')?;
    let hour: u8 = time.get(0..2)?.parse().ok()?;
    if hour >= day_boundary_hour {
        return Some(date.to_string());
    }
    previous_day(date)
}

/// 厳密な `YYYY-MM-DD`（ゼロ埋め・実在日）だけを許す。date 列は辞書順比較に
/// 依存しているため、桁ゆれ（`2026-7-4` 等）を通すと範囲検索から漏れる。
pub fn is_valid_date(date: &str) -> bool {
    let bytes = date.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return false;
    }
    let digits_ok = bytes
        .iter()
        .enumerate()
        .all(|(i, b)| matches!(i, 4 | 7) || b.is_ascii_digit());
    if !digits_ok {
        return false;
    }
    let year: i32 = date[0..4].parse().unwrap();
    let month: u32 = date[5..7].parse().unwrap();
    let day: u32 = date[8..10].parse().unwrap();
    (1..=12).contains(&month) && (1..=days_in_month(year, month)).contains(&day)
}

fn previous_day(date: &str) -> Option<String> {
    let mut parts = date.splitn(3, '-');
    let year: i32 = parts.next()?.parse().ok()?;
    let month: u32 = parts.next()?.parse().ok()?;
    let day: u32 = parts.next()?.parse().ok()?;
    if !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) {
        return None;
    }
    let (y, m, d) = if day > 1 {
        (year, month, day - 1)
    } else if month > 1 {
        (year, month - 1, days_in_month(year, month - 1))
    } else {
        (year - 1, 12, 31)
    };
    Some(format!("{y:04}-{m:02}-{d:02}"))
}

fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ => {
            if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 {
                29
            } else {
                28
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // TS 契約のスナップショット: web/src/types.gen.ts の discriminated union と
    // 一対一で対応する JSON 表現を文字列完全一致で固定する。
    #[test]
    fn kind_serde_representation() {
        let cases = [
            (
                NoteKind::Project { project_id: "o/r".to_string(), title: String::new() },
                r#"{"kind":"project","project_id":"o/r","title":""}"#,
            ),
            (NoteKind::Daily, r#"{"kind":"daily"}"#),
            (
                NoteKind::Essay { title: String::new(), status: EssayStatus::Writing },
                r#"{"kind":"essay","title":"","status":"writing"}"#,
            ),
            (
                NoteKind::Essay { title: "done".to_string(), status: EssayStatus::Finished },
                r#"{"kind":"essay","title":"done","status":"finished"}"#,
            ),
        ];
        for (kind, json) in cases {
            assert_eq!(serde_json::to_string(&kind).unwrap(), json);
            let parsed: NoteKind = serde_json::from_str(json).unwrap();
            assert_eq!(parsed, kind);
        }
    }

    // v42 以前の JSON（status / project title 欠落）が default で読めること。
    #[test]
    fn kind_serde_accepts_pre_v42_shapes() {
        let essay: NoteKind = serde_json::from_str(r#"{"kind":"essay","title":"t"}"#).unwrap();
        assert_eq!(essay, NoteKind::Essay { title: "t".to_string(), status: EssayStatus::Writing });
        let project: NoteKind =
            serde_json::from_str(r#"{"kind":"project","project_id":"o/r"}"#).unwrap();
        assert_eq!(
            project,
            NoteKind::Project { project_id: "o/r".to_string(), title: String::new() }
        );
    }

    #[test]
    fn essay_status_default_and_column_roundtrip() {
        assert_eq!(EssayStatus::default(), EssayStatus::Writing);
        for status in [EssayStatus::Writing, EssayStatus::Finished] {
            assert_eq!(EssayStatus::parse(status.as_str()), Some(status));
        }
        assert_eq!(EssayStatus::parse("drafting"), None);
        assert_eq!(EssayStatus::parse(""), None);
    }

    #[test]
    fn kind_default_is_daily() {
        assert_eq!(NoteKind::default(), NoteKind::Daily);
    }

    #[test]
    fn kind_accessors() {
        let project = NoteKind::Project { project_id: "o/r".to_string(), title: "p".to_string() };
        let essay = NoteKind::Essay { title: "t".to_string(), status: EssayStatus::Finished };
        assert_eq!(project.name(), "project");
        assert_eq!(project.project_id(), Some("o/r"));
        assert_eq!(project.title(), Some("p"));
        assert_eq!(project.status(), None);
        assert_eq!(NoteKind::Daily.name(), "daily");
        assert_eq!(NoteKind::Daily.title(), None);
        assert_eq!(NoteKind::Daily.project_id(), None);
        assert_eq!(NoteKind::Daily.status(), None);
        assert_eq!(essay.name(), "essay");
        assert_eq!(essay.title(), Some("t"));
        assert_eq!(essay.project_id(), None);
        assert_eq!(essay.status(), Some(EssayStatus::Finished));
    }

    #[test]
    fn display_name_per_kind() {
        let date = "2026-07-18";
        let titled = NoteKind::Essay { title: "My essay".to_string(), status: EssayStatus::Writing };
        let untitled = NoteKind::Essay { title: String::new(), status: EssayStatus::Writing };
        assert_eq!(titled.display_name(date), "My essay");
        assert_eq!(untitled.display_name(date), "Untitled");
        assert_eq!(NoteKind::Daily.display_name(date), "2026-07-18");
        // project の display_name は Phase 1 では title を使わない（Phase 3 の UI と一緒に検討）
        let project =
            NoteKind::Project { project_id: "owner/repo".to_string(), title: "named".to_string() };
        assert_eq!(project.display_name(date), "owner/repo");
    }

    #[test]
    fn transition_allowed() {
        assert_eq!(
            NoteKind::Daily.transition_to(NoteKindTarget::Essay),
            Ok(NoteKind::Essay { title: String::new(), status: EssayStatus::Writing })
        );
        assert_eq!(
            NoteKind::Daily
                .transition_to(NoteKindTarget::Project { project_id: "o/r".to_string() }),
            Ok(NoteKind::Project { project_id: "o/r".to_string(), title: String::new() })
        );
        // essay → daily は title を破棄する
        assert_eq!(
            NoteKind::Essay { title: "kept?".to_string(), status: EssayStatus::Writing }
                .transition_to(NoteKindTarget::Daily),
            Ok(NoteKind::Daily)
        );
    }

    #[test]
    fn transition_forbidden() {
        let project = NoteKind::Project { project_id: "o/r".to_string(), title: String::new() };
        let essay = NoteKind::Essay { title: "t".to_string(), status: EssayStatus::Writing };
        let to_project = || NoteKindTarget::Project { project_id: "other".to_string() };
        let forbidden: [(NoteKind, NoteKindTarget); 6] = [
            // project からの脱出経路なし（付け替え含む）
            (project.clone(), NoteKindTarget::Daily),
            (project.clone(), NoteKindTarget::Essay),
            (project.clone(), to_project()),
            // essay → project 直行なし
            (essay.clone(), to_project()),
            // 同一 kind への遷移なし
            (NoteKind::Daily, NoteKindTarget::Daily),
            (essay.clone(), NoteKindTarget::Essay),
        ];
        for (from, target) in forbidden {
            let err = from.clone().transition_to(target.clone()).unwrap_err();
            assert_eq!(err.from, from.name());
            assert_eq!(err.to, target.name());
        }
    }

    #[test]
    fn with_status_replaces_status_and_keeps_title() {
        let writing = NoteKind::Essay { title: "t".to_string(), status: EssayStatus::Writing };
        assert_eq!(
            writing.with_status(EssayStatus::Finished),
            Ok(NoteKind::Essay { title: "t".to_string(), status: EssayStatus::Finished })
        );
        let finished = NoteKind::Essay { title: "t".to_string(), status: EssayStatus::Finished };
        assert_eq!(
            finished.with_status(EssayStatus::Writing),
            Ok(NoteKind::Essay { title: "t".to_string(), status: EssayStatus::Writing })
        );
        // 同値への set も Ok（冪等）
        assert_eq!(writing.with_status(EssayStatus::Writing), Ok(writing.clone()));
    }

    #[test]
    fn with_status_rejects_non_essay() {
        let project = NoteKind::Project { project_id: "o/r".to_string(), title: String::new() };
        for kind in [NoteKind::Daily, project] {
            let err = kind.with_status(EssayStatus::Finished).unwrap_err();
            assert_eq!(err.kind, kind.name());
        }
    }

    #[test]
    fn logical_date_boundary_zero_passes_through() {
        assert_eq!(logical_date("2026-07-18T00:00:00", 0).as_deref(), Some("2026-07-18"));
        assert_eq!(logical_date("2026-07-18T23:59:59", 0).as_deref(), Some("2026-07-18"));
    }

    #[test]
    fn logical_date_shifts_before_boundary() {
        assert_eq!(logical_date("2026-07-18T04:59:59", 5).as_deref(), Some("2026-07-17"));
        assert_eq!(logical_date("2026-07-18T05:00:00", 5).as_deref(), Some("2026-07-18"));
    }

    #[test]
    fn logical_date_crosses_month_year_and_leap_day() {
        assert_eq!(logical_date("2026-07-01T02:00:00", 5).as_deref(), Some("2026-06-30"));
        assert_eq!(logical_date("2026-01-01T03:00:00", 5).as_deref(), Some("2025-12-31"));
        assert_eq!(logical_date("2024-03-01T01:00:00", 5).as_deref(), Some("2024-02-29"));
        assert_eq!(logical_date("2026-03-01T01:00:00", 5).as_deref(), Some("2026-02-28"));
        assert_eq!(logical_date("2100-03-01T01:00:00", 5).as_deref(), Some("2100-02-28"));
    }

    #[test]
    fn logical_date_boundary_23() {
        assert_eq!(logical_date("2026-07-18T22:59:59", 23).as_deref(), Some("2026-07-17"));
        assert_eq!(logical_date("2026-07-18T23:00:00", 23).as_deref(), Some("2026-07-18"));
    }

    #[test]
    fn logical_date_rejects_malformed_input() {
        assert_eq!(logical_date("2026-07-18", 5), None);
        assert_eq!(logical_date("not-a-date", 5), None);
        assert_eq!(logical_date("2026-13-01T02:00:00", 5), None);
    }

    #[test]
    fn valid_date_accepts_strict_calendar_dates() {
        assert!(is_valid_date("2026-07-24"));
        assert!(is_valid_date("2024-02-29")); // うるう日
        assert!(is_valid_date("2026-12-31"));
        assert!(is_valid_date("0001-01-01"));
    }

    #[test]
    fn valid_date_rejects_malformed_or_nonexistent() {
        assert!(!is_valid_date(""));
        assert!(!is_valid_date("2026-7-4")); // 非ゼロ埋め
        assert!(!is_valid_date("2026-07-4"));
        assert!(!is_valid_date("2026-13-01")); // 13 月
        assert!(!is_valid_date("2026-02-30")); // 実在しない日
        assert!(!is_valid_date("2026-02-29")); // 平年のうるう日
        assert!(!is_valid_date("2026-00-10"));
        assert!(!is_valid_date("2026-01-00"));
        assert!(!is_valid_date("not-a-date"));
        assert!(!is_valid_date("2026-07-24T00:00:00"));
        assert!(!is_valid_date("2026/07/24"));
    }

    fn summary(id: &str) -> NoteSummary {
        NoteSummary {
            id: NoteId::from_store(id.to_string()),
            kind: NoteKind::Daily,
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
