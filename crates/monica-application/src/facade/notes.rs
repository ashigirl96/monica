use monica_domain::{
    to_markdown, DailyNoteCount, Note, NoteId, NoteKindTarget, NotePage, NoteSummary, RawJson,
    SyncedBlockMode, UpdateNote,
};

use super::Backend;
use crate::error::{ApplicationError, ApplicationResult};
use crate::ports::NoteStore;
use crate::usecases::notes::StoreNoteResolver;

/// project filter 表示の 1 ページあたりの件数。フロントは has_more を見るだけで、
/// この値を知る必要はない。
const NOTE_PAGE_SIZE: usize = 100;

/// mention 検索が返す最大件数（dropdown 表示分）。
const MENTION_SEARCH_LIMIT: usize = 20;
/// coarse プリフィルタの overfetch 幅。precise フィルタ（display_name / preview）で
/// 落ちる分を見込んで多めに取る。
const MENTION_COARSE_LIMIT: usize = 200;

/// 全文検索（CLI / agent 用）が返す最大件数。
const NOTE_SEARCH_LIMIT: usize = 50;

pub struct NoteService<'a, B: Backend> {
    pub(in crate::facade) m: &'a mut super::Monica<B>,
}

impl<B: Backend> NoteService<'_, B> {
    pub fn create_note(&mut self, day_boundary_hour: u8) -> ApplicationResult<Note> {
        Ok(self.m.repos.create_note(day_boundary_hour)?)
    }

    /// daily の get-or-create の唯一の入口。「1日1つ」の不変条件は DB 制約ではなく
    /// ここ（+ store の原子的な get-or-create）で保証する。未来日は許可 — カレンダーの
    /// 先日付タップと、day boundary 際の client/server 時差を弾かないため。
    /// 注: Phase 1 では旧 /notes の create_note（⌥N）が並存するため、旧経路からは
    /// 同日複数の daily が依然作れる。不変条件が完全になるのは旧経路撤去後（Phase 3）。
    pub fn daily_note_for(&mut self, date: &str) -> ApplicationResult<Note> {
        if !monica_domain::is_valid_date(date) {
            return Err(ApplicationError::validation(format!("invalid date: {date}")));
        }
        Ok(self.m.repos.get_or_create_daily_note(date)?)
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

    /// 全 note の content JSON（soft-delete 含む）。asset GC の到達可能性判定用。
    pub fn list_all_note_contents(&mut self) -> ApplicationResult<Vec<monica_domain::RawJson>> {
        Ok(self.m.repos.list_all_note_contents()?)
    }

    pub fn list_project_notes(
        &mut self,
        project_id: &str,
        offset: usize,
    ) -> ApplicationResult<NotePage> {
        let items = self.m.repos.list_project_notes(project_id, NOTE_PAGE_SIZE + 1, offset)?;
        Ok(NotePage::from_overfetch(items, NOTE_PAGE_SIZE))
    }

    /// wiki link（`[[`）用の mention 検索。store の coarse LIKE は superset を返すだけ
    /// なので、ここで display_name / preview の部分一致に正確に絞る。
    pub fn search_note_mentions(&mut self, q: &str) -> ApplicationResult<Vec<NoteSummary>> {
        let q = q.trim().to_lowercase();
        // 空 q は precise フィルタで落ちる行が無いので overfetch 不要
        let limit = if q.is_empty() { MENTION_SEARCH_LIMIT } else { MENTION_COARSE_LIMIT };
        let mut items = self.m.repos.search_notes(&q, limit)?;
        items.retain(|s| {
            s.kind.display_name(&s.date).to_lowercase().contains(&q)
                || s.preview.as_deref().is_some_and(|p| p.to_lowercase().contains(&q))
        });
        items.truncate(MENTION_SEARCH_LIMIT);
        Ok(items)
    }

    pub fn get_note(&mut self, id: &str) -> ApplicationResult<Note> {
        NoteId::parse(id)?;
        self.m
            .repos
            .get_note(id)?
            .ok_or_else(|| ApplicationError::not_found(format!("note {id} not found")))
    }

    /// note content の markdown 投影（読み取り専用）。真実は content JSON のまま。
    /// noteMention のタイトルと syncedBlock の内容は同じ store 越しに解決する。
    pub fn note_markdown(&mut self, id: &str, mode: SyncedBlockMode) -> ApplicationResult<String> {
        NoteId::parse(id)?;
        let note = self
            .m
            .repos
            .get_note(id)?
            .ok_or_else(|| ApplicationError::not_found(format!("note {id} not found")))?;
        let resolver = StoreNoteResolver(&self.m.repos);
        Ok(to_markdown(note.content.as_str(), &resolver, mode))
    }

    /// 任意の content JSON（選択範囲を doc 形状に包んだもの）の markdown 投影（読み取り専用）。
    /// note-id を介さない点だけが `note_markdown` と異なる。to_markdown は失敗しないので Result なし。
    pub fn markdown_from_content(&mut self, content: &str, mode: SyncedBlockMode) -> String {
        let resolver = StoreNoteResolver(&self.m.repos);
        to_markdown(content, &resolver, mode)
    }

    /// 全文検索（agent / CLI 用）。mention 検索と違い precise 再フィルタは掛けず、store の
    /// FTS 結果をそのまま返す。
    pub fn search_notes(&mut self, q: &str) -> ApplicationResult<Vec<NoteSummary>> {
        Ok(self.m.repos.search_notes(q.trim(), NOTE_SEARCH_LIMIT)?)
    }

    /// synced block（transclusion）の解決。note 不在・削除済み・block 不在はすべて
    /// not_found（フロントはいずれも dangling 表示なので区別しない）。
    pub fn get_note_block(&mut self, id: &str, block_id: &str) -> ApplicationResult<RawJson> {
        NoteId::parse(id)?;
        self.m.repos.get_note_block(id, block_id)?.ok_or_else(|| {
            ApplicationError::not_found(format!("block {block_id} not found in note {id}"))
        })
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
        kind: Option<&str>,
    ) -> ApplicationResult<Vec<DailyNoteCount>> {
        Ok(self.m.repos.daily_note_counts(from, to, kind)?)
    }
}
