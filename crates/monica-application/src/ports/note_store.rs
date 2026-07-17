use anyhow::Result;

use monica_domain::{DailyNoteCount, Note, NoteSummary, UpdateNote};

pub trait NoteStore {
    /// Creates a note with all defaults (id, kind, empty content, local date, timestamps).
    fn create_note(&mut self) -> Result<Note>;
    fn get_note(&self, id: &str) -> Result<Option<Note>>;
    fn list_notes(&self, from: Option<&str>, to: Option<&str>) -> Result<Vec<NoteSummary>>;
    /// One project's notes, newest first (same ordering as [`list_notes`](Self::list_notes)).
    fn list_project_notes(
        &self,
        project_id: &str,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<NoteSummary>>;
    /// Full replace; returns `None` when the note does not exist (or is soft-deleted).
    fn update_note(&mut self, id: &str, update: UpdateNote) -> Result<Option<Note>>;
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
}
