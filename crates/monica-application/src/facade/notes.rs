use monica_domain::{
    to_markdown, DailyNoteCount, EssayStatus, Note, NoteId, NotePage, NoteSummary, RawJson,
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
    /// ⌥N（/essays）の新規 essay。空 title・status Writing で logical today に作る。
    pub fn create_essay(&mut self, day_boundary_hour: u8) -> ApplicationResult<Note> {
        Ok(self.m.repos.create_essay_note(day_boundary_hour)?)
    }

    /// /essays 一覧とエディタサイドバーの共有ソース（全 status、updated_at 降順）。
    /// writing だけへの絞り込みは表示都合なのでフロントの責務。
    pub fn list_essays(&mut self) -> ApplicationResult<Vec<NoteSummary>> {
        Ok(self.m.repos.list_essay_notes()?)
    }

    /// ⌥N（/projects）の新規 project note。存在しない project は 404
    /// （FK 違反 500 を避けるため project の存在を先に検証する）。
    pub fn create_project_note(
        &mut self,
        project_id: &str,
        day_boundary_hour: u8,
    ) -> ApplicationResult<Note> {
        crate::usecases::query::get_project(&self.m.repos, project_id)?;
        Ok(self.m.repos.create_project_note(project_id, day_boundary_hour)?)
    }

    /// /projects を開いたときの primary note の get-or-create。既存 project の
    /// backfill を兼ねる（初オープン時に lazy 作成）。存在しない project は 404。
    pub fn primary_note_for(
        &mut self,
        project_id: &str,
        day_boundary_hour: u8,
    ) -> ApplicationResult<Note> {
        crate::usecases::query::get_project(&self.m.repos, project_id)?;
        Ok(self.m.repos.get_or_create_primary_note(project_id, day_boundary_hour)?)
    }

    pub fn set_essay_status(
        &mut self,
        id: &str,
        status: EssayStatus,
    ) -> ApplicationResult<Note> {
        NoteId::parse(id)?;
        let note = self
            .m
            .repos
            .get_note(id)?
            .ok_or_else(|| ApplicationError::not_found(format!("note {id} not found")))?;
        note.kind.with_status(status).map_err(|e| ApplicationError::conflict(e.to_string()))?;
        // store 側も kind = 'essay' 条件付き。get と write の間に kind 遷移が滑り込んだら不発。
        self.m.repos.set_essay_status(id, status)?.ok_or_else(|| {
            ApplicationError::conflict(format!("note {id} kind changed concurrently"))
        })
    }

    /// daily の get-or-create の唯一の入口。「1日1つ」の不変条件は DB 制約ではなく
    /// ここ（+ store の原子的な get-or-create）で保証する。未来日は許可 — カレンダーの
    /// 先日付タップと、day boundary 際の client/server 時差を弾かないため。
    /// daily を作る HTTP 経路はこれだけなので（旧 /notes の create_note 経路は撤去済み）、
    /// 不変条件が閉じる。
    pub fn daily_note_for(&mut self, date: &str) -> ApplicationResult<Note> {
        if !monica_domain::is_valid_date(date) {
            return Err(ApplicationError::validation(format!("invalid date: {date}")));
        }
        Ok(self.m.repos.get_or_create_daily_note(date)?)
    }

    pub fn logical_today(&mut self, day_boundary_hour: u8) -> ApplicationResult<String> {
        Ok(self.m.repos.logical_today(day_boundary_hour)?)
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
