use monica_domain::NoteDocResolver;

use crate::ports::NoteStore;

/// `NoteStore` 越しに markdown 投影の解決（noteMention タイトル・syncedBlock 内容）を行う。
/// エラー・不在・削除済みはすべて `None` に潰す — 投影側は None を参照記法へ fallback する。
pub(crate) struct StoreNoteResolver<'r, R: NoteStore>(pub &'r R);

impl<R: NoteStore> NoteDocResolver for StoreNoteResolver<'_, R> {
    fn note_display_name(&self, note_id: &str) -> Option<String> {
        let note = self.0.get_note(note_id).ok()??;
        Some(note.kind.display_name(&note.date))
    }

    fn block_subtree(&self, note_id: &str, block_id: &str) -> Option<String> {
        Some(self.0.get_note_block(note_id, block_id).ok()??.into_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::{anyhow, Result};
    use monica_domain::{
        DailyNoteCount, EssayStatus, Note, NoteDocResolver, NoteId, NoteKind, NoteSummary,
        RawJson, UpdateNote,
    };

    /// get_note / get_note_block だけ本物の値を返す最小 store。他は resolver が触らない。
    struct FakeStore;

    impl NoteStore for FakeStore {
        fn get_note(&self, id: &str) -> Result<Option<Note>> {
            match id {
                "note-1" => Ok(Some(Note {
                    id: NoteId::from_store("note-1".to_string()),
                    kind: NoteKind::Essay {
                        title: "My Essay".to_string(),
                        status: EssayStatus::Writing,
                    },
                    content: RawJson::from("{}"),
                    date: "2026-07-19".to_string(),
                    created_at: "2026-07-19T00:00:00.000Z".to_string(),
                    updated_at: "2026-07-19T00:00:00.000Z".to_string(),
                })),
                "note-boom" => Err(anyhow!("db error")),
                _ => Ok(None),
            }
        }

        fn get_note_block(&self, note_id: &str, block_id: &str) -> Result<Option<RawJson>> {
            match (note_id, block_id) {
                ("note-1", "blk") => Ok(Some(RawJson::from("subtree-json"))),
                _ => Ok(None),
            }
        }

        fn create_note(&mut self, _: u8) -> Result<Note> {
            unimplemented!()
        }
        fn create_essay_note(&mut self, _: u8) -> Result<Note> {
            unimplemented!()
        }
        fn list_essay_notes(&self) -> Result<Vec<NoteSummary>> {
            unimplemented!()
        }
        fn set_essay_status(&mut self, _: &str, _: EssayStatus) -> Result<Option<Note>> {
            unimplemented!()
        }
        fn get_or_create_daily_note(&mut self, _: &str) -> Result<Note> {
            unimplemented!()
        }
        fn list_notes(&self, _: Option<&str>, _: Option<&str>) -> Result<Vec<NoteSummary>> {
            unimplemented!()
        }
        fn list_all_note_contents(&self) -> Result<Vec<RawJson>> {
            unimplemented!()
        }
        fn search_notes(&self, _: &str, _: usize) -> Result<Vec<NoteSummary>> {
            unimplemented!()
        }
        fn list_project_notes(&self, _: &str, _: usize, _: usize) -> Result<Vec<NoteSummary>> {
            unimplemented!()
        }
        fn update_note(&mut self, _: &str, _: UpdateNote) -> Result<Option<Note>> {
            unimplemented!()
        }
        fn set_note_kind(&mut self, _: &str, _: &str, _: &NoteKind) -> Result<Option<Note>> {
            unimplemented!()
        }
        fn delete_note(&mut self, _: &str) -> Result<bool> {
            unimplemented!()
        }
        fn restore_note(&mut self, _: &str) -> Result<Option<Note>> {
            unimplemented!()
        }
        fn daily_note_counts(
            &self,
            _: Option<&str>,
            _: Option<&str>,
            _: Option<&str>,
        ) -> Result<Vec<DailyNoteCount>> {
            unimplemented!()
        }
        fn logical_today(&self, _: u8) -> Result<String> {
            unimplemented!()
        }
    }

    #[test]
    fn display_name_from_kind() {
        let resolver = StoreNoteResolver(&FakeStore);
        assert_eq!(resolver.note_display_name("note-1"), Some("My Essay".to_string()));
    }

    #[test]
    fn missing_and_erroring_notes_resolve_to_none() {
        let resolver = StoreNoteResolver(&FakeStore);
        assert_eq!(resolver.note_display_name("note-404"), None);
        assert_eq!(resolver.note_display_name("note-boom"), None, "store error は None に潰す");
    }

    #[test]
    fn block_subtree_passthrough_and_miss() {
        let resolver = StoreNoteResolver(&FakeStore);
        assert_eq!(resolver.block_subtree("note-1", "blk"), Some("subtree-json".to_string()));
        assert_eq!(resolver.block_subtree("note-1", "nope"), None);
    }
}
