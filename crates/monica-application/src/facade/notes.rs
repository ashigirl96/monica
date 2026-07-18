use monica_domain::{
    DailyNoteCount, Note, NoteId, NoteKindTarget, NotePage, NoteSummary, UpdateNote,
};

use super::Backend;
use crate::error::{ApplicationError, ApplicationResult};
use crate::ports::NoteStore;

/// project filter 表示の 1 ページあたりの件数。フロントは has_more を見るだけで、
/// この値を知る必要はない。
const NOTE_PAGE_SIZE: usize = 100;

pub struct NoteService<'a, B: Backend> {
    pub(in crate::facade) m: &'a mut super::Monica<B>,
}

impl<B: Backend> NoteService<'_, B> {
    pub fn create_note(&mut self, day_boundary_hour: u8) -> ApplicationResult<Note> {
        Ok(self.m.repos.create_note(day_boundary_hour)?)
    }

    pub fn logical_today(&mut self, day_boundary_hour: u8) -> ApplicationResult<String> {
        Ok(self.m.repos.logical_today(day_boundary_hour)?)
    }

    pub fn list_notes(
        &mut self,
        from: Option<&str>,
        to: Option<&str>,
    ) -> ApplicationResult<Vec<NoteSummary>> {
        Ok(self.m.repos.list_notes(from, to)?)
    }

    pub fn list_project_notes(
        &mut self,
        project_id: &str,
        offset: usize,
    ) -> ApplicationResult<NotePage> {
        let items = self.m.repos.list_project_notes(project_id, NOTE_PAGE_SIZE + 1, offset)?;
        Ok(NotePage::from_overfetch(items, NOTE_PAGE_SIZE))
    }

    pub fn get_note(&mut self, id: &str) -> ApplicationResult<Note> {
        NoteId::parse(id)?;
        self.m
            .repos
            .get_note(id)?
            .ok_or_else(|| ApplicationError::not_found(format!("note {id} not found")))
    }

    pub fn update_note(&mut self, id: &str, update: UpdateNote) -> ApplicationResult<Note> {
        NoteId::parse(id)?;
        self.m
            .repos
            .update_note(id, update)?
            .ok_or_else(|| ApplicationError::not_found(format!("note {id} not found")))
    }

    pub fn set_note_kind(&mut self, id: &str, target: NoteKindTarget) -> ApplicationResult<Note> {
        NoteId::parse(id)?;
        let note = self
            .m
            .repos
            .get_note(id)?
            .ok_or_else(|| ApplicationError::not_found(format!("note {id} not found")))?;
        // FK 違反を SQLite エラー (500) にせず、先に存在チェックして not_found を返す。
        if let NoteKindTarget::Project { project_id } = &target {
            crate::usecases::query::get_project(&self.m.repos, project_id)?;
        }
        let next = note
            .kind
            .transition_to(target)
            .map_err(|e| ApplicationError::conflict(e.to_string()))?;
        // 書き込みは遷移元 kind 条件付き。get と write の間に別の遷移が滑り込んだ場合は
        // 不発になる（project の終端性を並行リクエストでも破らせない）。
        self.m.repos.set_note_kind(id, note.kind.name(), &next)?.ok_or_else(|| {
            ApplicationError::conflict(format!("note {id} kind changed concurrently"))
        })
    }

    pub fn delete_note(&mut self, id: &str) -> ApplicationResult<()> {
        NoteId::parse(id)?;
        if !self.m.repos.delete_note(id)? {
            return Err(ApplicationError::not_found(format!("note {id} not found")));
        }
        Ok(())
    }

    pub fn restore_note(&mut self, id: &str) -> ApplicationResult<Note> {
        NoteId::parse(id)?;
        self.m
            .repos
            .restore_note(id)?
            .ok_or_else(|| ApplicationError::not_found(format!("note {id} not found")))
    }

    pub fn daily_counts(
        &mut self,
        from: Option<&str>,
        to: Option<&str>,
    ) -> ApplicationResult<Vec<DailyNoteCount>> {
        Ok(self.m.repos.daily_note_counts(from, to)?)
    }
}
