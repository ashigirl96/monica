use anyhow::Result;

use monica_domain::{DailyNoteCount, Note, NoteKind, NoteSummary, RawJson, UpdateNote};

pub trait NoteStore {
    /// Creates a daily note with all defaults (id, empty content, logical date, timestamps).
    fn create_note(&mut self, day_boundary_hour: u8) -> Result<Note>;
    /// `date`（検証済み `YYYY-MM-DD`）の daily note の get-or-create。SELECT と INSERT を
    /// 原子的に行い、同日に live な daily が複数ある場合は最古（rowid 最小）を返す。
    fn get_or_create_daily_note(&mut self, date: &str) -> Result<Note>;
    fn get_note(&self, id: &str) -> Result<Option<Note>>;
    /// synced block（transclusion）の解決: note の content から `attrs.id == block_id` の
    /// blockContainer subtree を JSON で返す。note が存在しない/削除済み、または block が
    /// 見つからない場合は `None`。
    fn get_note_block(&self, note_id: &str, block_id: &str) -> Result<Option<RawJson>>;
    fn list_notes(&self, from: Option<&str>, to: Option<&str>) -> Result<Vec<NoteSummary>>;
    /// Every note's content JSON, **including soft-deleted notes**. Used by asset GC to compute
    /// reachability: a soft-deleted note is restorable, so its asset references must count as live.
    fn list_all_note_contents(&self) -> Result<Vec<RawJson>>;
    /// 全文検索の coarse プリフィルタ。title / project_id / date は部分一致、本文は plain_text
    /// 投影への FTS5（3 codepoint 以上は trigram MATCH、未満は body LIKE）で、いずれかに当たる
    /// superset を新しい順に返す。display_name / preview による正確な絞り込みは application 層の
    /// 責務。空 `q` は全件（最近順）。本文一致は plain_text 経由なので schema 語彙（`paragraph`
    /// 等）には当たらない。preview は plain_text の部分文字列なので superset 契約は維持される。
    fn search_notes(&self, q: &str, limit: usize) -> Result<Vec<NoteSummary>>;
    /// One project's notes, newest first (same ordering as [`list_notes`](Self::list_notes)).
    fn list_project_notes(
        &self,
        project_id: &str,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<NoteSummary>>;
    /// Replaces content (and, for essays, title); returns `None` when the note does not
    /// exist (or is soft-deleted). kind は変更しない — 遷移は [`set_note_kind`](Self::set_note_kind)。
    fn update_note(&mut self, id: &str, update: UpdateNote) -> Result<Option<Note>>;
    /// Writes the kind (with its payload columns) verbatim; transition rules are the
    /// caller's responsibility. The write is conditional on the current kind still being
    /// `expected_kind`（呼び手が検証した遷移元）— 並行する遷移が同じ pre-update 状態で
    /// 検証をすり抜けて上書きし合うのを防ぐ。Returns `None` when the note does not
    /// exist (or is deleted), or when the kind changed since it was read.
    fn set_note_kind(&mut self, id: &str, expected_kind: &str, kind: &NoteKind)
        -> Result<Option<Note>>;
    /// Soft delete: sets `deleted_at`; the row survives for [`restore_note`](Self::restore_note).
    /// Returns `false` when the note does not exist (or is already deleted).
    fn delete_note(&mut self, id: &str) -> Result<bool>;
    /// Clears `deleted_at`; returns `None` when the id does not exist.
    fn restore_note(&mut self, id: &str) -> Result<Option<Note>>;
    /// date ごとの note 件数。`kind` を渡すとその kind だけを数える（None = 全 kind、
    /// 旧 /notes カレンダーの従来挙動）。
    fn daily_note_counts(
        &self,
        from: Option<&str>,
        to: Option<&str>,
        kind: Option<&str>,
    ) -> Result<Vec<DailyNoteCount>>;
    /// day boundary 設定を適用した「今日」の logical date（`YYYY-MM-DD`）。
    fn logical_today(&self, day_boundary_hour: u8) -> Result<String>;
}
