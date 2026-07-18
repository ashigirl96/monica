use anyhow::Result;

use monica_domain::{DailyNoteCount, Note, NoteKind, NoteSummary, UpdateNote};

pub trait NoteStore {
    /// Creates a daily note with all defaults (id, empty content, logical date, timestamps).
    fn create_note(&mut self, day_boundary_hour: u8) -> Result<Note>;
    fn get_note(&self, id: &str) -> Result<Option<Note>>;
    fn list_notes(&self, from: Option<&str>, to: Option<&str>) -> Result<Vec<NoteSummary>>;
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
    fn daily_note_counts(
        &self,
        from: Option<&str>,
        to: Option<&str>,
    ) -> Result<Vec<DailyNoteCount>>;
    /// day boundary 設定を適用した「今日」の logical date（`YYYY-MM-DD`）。
    fn logical_today(&self, day_boundary_hour: u8) -> Result<String>;
}
