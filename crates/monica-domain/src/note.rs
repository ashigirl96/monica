use serde::{Deserialize, Serialize};

use crate::ids::NoteId;
use crate::json::RawJson;

/// 空ノートの正規形。block editor の schema（doc → blockGroup → blockContainer → paragraph）を
/// 満たす最小の doc。schema 違反の `{"type":"doc","content":[]}` を空の意味で使うと、
/// エディタ側の破損フォールバックと区別できなくなるため、空は必ずこの形で表す。
pub const EMPTY_NOTE_DOC: &str = r#"{"type":"doc","content":[{"type":"blockGroup","content":[{"type":"blockContainer","content":[{"type":"paragraph"}]}]}]}"#;

/// note の「取り出し方」による分類。分類の軸が取り出し経路（project 経由 /
/// カレンダー・今日経由 / タイトル一覧経由）なので重複がなく、title / project_id の
/// 不変条件（project は project_id 必須、essay は title 非 NULL、daily はどちらも持たない）を
/// 型で強制する。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NoteKind {
    /// project に紐づけて取り出す note。title を持たない。
    Project { project_id: String },
    /// その日の logical date に属する inbox。title を持たない。1日複数可。
    #[default]
    Daily,
    /// タイトル一覧から取り出す成果物。空文字は「無題」として許容する。
    Essay { title: String },
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

    pub fn title(&self) -> Option<&str> {
        match self {
            NoteKind::Essay { title } => Some(title),
            _ => None,
        }
    }

    pub fn project_id(&self) -> Option<&str> {
        match self {
            NoteKind::Project { project_id } => Some(project_id),
            _ => None,
        }
    }

    /// mention（wiki link）の表示名。検索と解決で共有する唯一の導出規則。
    /// daily は ISO 日付をそのまま返す — 曜日等の整形はロケール依存の presentation
    /// なのでここでは持たない。
    pub fn display_name(&self, date: &str) -> String {
        match self {
            NoteKind::Essay { title } if !title.is_empty() => title.clone(),
            NoteKind::Essay { .. } => "Untitled".to_string(),
            NoteKind::Daily => date.to_string(),
            NoteKind::Project { project_id } => project_id.clone(),
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
                Ok(NoteKind::Essay { title: String::new() })
            }
            (NoteKind::Daily, NoteKindTarget::Project { project_id }) => {
                Ok(NoteKind::Project { project_id })
            }
            (NoteKind::Essay { .. }, NoteKindTarget::Daily) => Ok(NoteKind::Daily),
            (from, target) => {
                Err(KindTransitionError { from: from.name(), to: target.name() })
            }
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
                NoteKind::Project { project_id: "o/r".to_string() },
                r#"{"kind":"project","project_id":"o/r"}"#,
            ),
            (NoteKind::Daily, r#"{"kind":"daily"}"#),
            (
                NoteKind::Essay { title: String::new() },
                r#"{"kind":"essay","title":""}"#,
            ),
        ];
        for (kind, json) in cases {
            assert_eq!(serde_json::to_string(&kind).unwrap(), json);
            let parsed: NoteKind = serde_json::from_str(json).unwrap();
            assert_eq!(parsed, kind);
        }
    }

    #[test]
    fn kind_default_is_daily() {
        assert_eq!(NoteKind::default(), NoteKind::Daily);
    }

    #[test]
    fn kind_accessors() {
        let project = NoteKind::Project { project_id: "o/r".to_string() };
        let essay = NoteKind::Essay { title: "t".to_string() };
        assert_eq!(project.name(), "project");
        assert_eq!(project.project_id(), Some("o/r"));
        assert_eq!(project.title(), None);
        assert_eq!(NoteKind::Daily.name(), "daily");
        assert_eq!(NoteKind::Daily.title(), None);
        assert_eq!(NoteKind::Daily.project_id(), None);
        assert_eq!(essay.name(), "essay");
        assert_eq!(essay.title(), Some("t"));
        assert_eq!(essay.project_id(), None);
    }

    #[test]
    fn display_name_per_kind() {
        let date = "2026-07-18";
        assert_eq!(NoteKind::Essay { title: "My essay".to_string() }.display_name(date), "My essay");
        assert_eq!(NoteKind::Essay { title: String::new() }.display_name(date), "Untitled");
        assert_eq!(NoteKind::Daily.display_name(date), "2026-07-18");
        assert_eq!(
            NoteKind::Project { project_id: "owner/repo".to_string() }.display_name(date),
            "owner/repo"
        );
    }

    #[test]
    fn transition_allowed() {
        assert_eq!(
            NoteKind::Daily.transition_to(NoteKindTarget::Essay),
            Ok(NoteKind::Essay { title: String::new() })
        );
        assert_eq!(
            NoteKind::Daily
                .transition_to(NoteKindTarget::Project { project_id: "o/r".to_string() }),
            Ok(NoteKind::Project { project_id: "o/r".to_string() })
        );
        // essay → daily は title を破棄する
        assert_eq!(
            NoteKind::Essay { title: "kept?".to_string() }.transition_to(NoteKindTarget::Daily),
            Ok(NoteKind::Daily)
        );
    }

    #[test]
    fn transition_forbidden() {
        let project = NoteKind::Project { project_id: "o/r".to_string() };
        let essay = NoteKind::Essay { title: "t".to_string() };
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
