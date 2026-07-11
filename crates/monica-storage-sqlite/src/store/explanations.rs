use anyhow::Result;
use monica_application::ports::ExplanationStore;
use monica_domain::{Explanation, ExplanationId, ExplanationMode, NewExplanation, repo_name_from_cwd};
use rusqlite::{params, Row};

use crate::SqliteStore;

use super::{EXPLANATION_COLUMNS, EXPLANATION_FROM};

fn explanation_from_row(row: &Row<'_>) -> Result<Explanation> {
    let mode: String = row.get("mode")?;
    let stored_repo_name: Option<String> = row.get("repo_name")?;
    let cwd: Option<String> = row.get("cwd")?;
    Ok(Explanation {
        id: ExplanationId::from_store(row.get("id")?),
        title: row.get("title")?,
        summary: row.get("summary")?,
        mode: mode.parse::<ExplanationMode>()?,
        provider_session_id: row.get("provider_session_id")?,
        terminal_session_id: row.get("terminal_session_id")?,
        created_at: row.get("created_at")?,
        repo_name: stored_repo_name.or_else(|| cwd.as_deref().and_then(repo_name_from_cwd)),
    })
}

fn insert_explanation_in(
    conn: &rusqlite::Connection,
    new: NewExplanation,
) -> Result<Explanation> {
    conn.execute("INSERT INTO explanation_counter DEFAULT VALUES", [])?;
    let id = format!("expl-{}", conn.last_insert_rowid());
    conn.execute(
        "INSERT INTO explanations (id, title, summary, mode, provider_session_id, terminal_session_id, repo_name)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            id,
            new.title,
            new.summary,
            new.mode.as_str(),
            new.provider_session_id,
            new.terminal_session_id,
            new.repo_name,
        ],
    )?;
    let mut stmt = conn.prepare(&format!(
        "SELECT {EXPLANATION_COLUMNS} FROM {EXPLANATION_FROM} WHERE e.id = ?1"
    ))?;
    let mut rows = stmt.query(params![id])?;
    let row = rows.next()?.expect("just inserted");
    explanation_from_row(row)
}

impl ExplanationStore for SqliteStore {
    fn list_explanations(&self) -> Result<Vec<Explanation>> {
        let mut stmt = self.conn().prepare(&format!(
            "SELECT {EXPLANATION_COLUMNS} FROM {EXPLANATION_FROM} ORDER BY e.created_at DESC, e.rowid DESC"
        ))?;
        let rows = stmt.query_map([], |row| Ok(explanation_from_row(row)))?;
        rows.map(|r| r?).collect()
    }

    fn get_explanation(&self, id: &str) -> Result<Option<Explanation>> {
        let mut stmt = self.conn().prepare(&format!(
            "SELECT {EXPLANATION_COLUMNS} FROM {EXPLANATION_FROM} WHERE e.id = ?1"
        ))?;
        let mut rows = stmt.query(params![id])?;
        match rows.next()? {
            Some(row) => Ok(Some(explanation_from_row(row)?)),
            None => Ok(None),
        }
    }

    fn insert_explanation(&mut self, new: NewExplanation) -> Result<Explanation> {
        let tx = self.conn_mut().transaction()?;
        let explanation = insert_explanation_in(&tx, new)?;
        tx.commit()?;
        Ok(explanation)
    }

    fn delete_explanation(&mut self, id: &str) -> Result<()> {
        self.conn().execute("DELETE FROM explanations WHERE id = ?1", params![id])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use monica_domain::{NewTerminalSession, TerminalSessionKind};

    fn seed_terminal_session(store: &mut SqliteStore) -> String {
        seed_terminal_session_with_cwd(store, "/Users/user/repos/monica")
    }

    fn seed_terminal_session_with_cwd(store: &mut SqliteStore, cwd: &str) -> String {
        let session = store
            .create_terminal_session(NewTerminalSession {
                runspace_id: None,
                tab_id: None,
                kind: TerminalSessionKind::Shell,
                cwd: cwd.to_string(),
                shell: "/bin/zsh".to_string(),
                rows: 24,
                cols: 80,
            })
            .unwrap();
        session.id
    }

    #[test]
    fn insert_and_read_back() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        let ts_id = seed_terminal_session(&mut store);
        let explanation = store
            .insert_explanation(NewExplanation {
                title: "test explanation".to_string(),
                summary: Some("test summary".to_string()),
                mode: ExplanationMode::Diff,
                provider_session_id: "provider-123".to_string(),
                terminal_session_id: ts_id.clone(),
                repo_name: Some("my-repo".to_string()),
            })
            .unwrap();
        assert_eq!(explanation.id, "expl-1");
        assert_eq!(explanation.title, "test explanation");
        assert_eq!(explanation.summary.as_deref(), Some("test summary"));
        assert_eq!(explanation.mode, ExplanationMode::Diff);
        assert_eq!(explanation.provider_session_id, "provider-123");
        assert_eq!(explanation.terminal_session_id, ts_id);
        assert!(!explanation.created_at.is_empty());
        assert_eq!(explanation.repo_name.as_deref(), Some("my-repo"));
    }

    #[test]
    fn repo_name_falls_back_to_cwd_when_not_stored() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        let ts_id = seed_terminal_session(&mut store);
        let explanation = store
            .insert_explanation(NewExplanation {
                title: "no stored repo".to_string(),
                summary: None,
                mode: ExplanationMode::Diff,
                provider_session_id: "p1".to_string(),
                terminal_session_id: ts_id,
                repo_name: None,
            })
            .unwrap();
        assert_eq!(explanation.repo_name.as_deref(), Some("monica"));
    }

    #[test]
    fn repo_name_from_worktree_cwd() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        let ts_id = seed_terminal_session_with_cwd(
            &mut store,
            "/Users/user/repos/monica/.worktrees/issue-363",
        );
        let explanation = store
            .insert_explanation(NewExplanation {
                title: "worktree test".to_string(),
                summary: None,
                mode: ExplanationMode::Diff,
                provider_session_id: "p1".to_string(),
                terminal_session_id: ts_id,
                repo_name: None,
            })
            .unwrap();
        assert_eq!(explanation.repo_name.as_deref(), Some("monica"));
    }

    #[test]
    fn insert_with_invalid_terminal_session_fails() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        let result = store.insert_explanation(NewExplanation {
            title: "orphan".to_string(),
            summary: None,
            mode: ExplanationMode::Diff,
            provider_session_id: "p1".to_string(),
            terminal_session_id: "ts-nonexistent".to_string(),
            repo_name: None,
        });
        assert!(result.is_err());
    }

    #[test]
    fn list_returns_descending_order() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        let ts_id = seed_terminal_session(&mut store);
        store
            .insert_explanation(NewExplanation {
                title: "first".to_string(),
                summary: Some("first summary".to_string()),
                mode: ExplanationMode::Diff,
                provider_session_id: "p1".to_string(),
                terminal_session_id: ts_id.clone(),
                repo_name: None,
            })
            .unwrap();
        store
            .insert_explanation(NewExplanation {
                title: "second".to_string(),
                summary: None,
                mode: ExplanationMode::Topic,
                provider_session_id: "p2".to_string(),
                terminal_session_id: ts_id,
                repo_name: None,
            })
            .unwrap();

        let list = store.list_explanations().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].title, "second");
        assert!(list[0].summary.is_none());
        assert_eq!(list[1].title, "first");
        assert_eq!(list[1].summary.as_deref(), Some("first summary"));
    }

    #[test]
    fn get_existing_and_missing() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        let ts_id = seed_terminal_session(&mut store);
        store
            .insert_explanation(NewExplanation {
                title: "target".to_string(),
                summary: None,
                mode: ExplanationMode::Diff,
                provider_session_id: "p1".to_string(),
                terminal_session_id: ts_id,
                repo_name: None,
            })
            .unwrap();

        let found = store.get_explanation("expl-1").unwrap();
        assert!(found.is_some());
        assert_eq!(found.unwrap().title, "target");

        let missing = store.get_explanation("expl-999").unwrap();
        assert!(missing.is_none());
    }

    #[test]
    fn ids_increment() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        let ts_id = seed_terminal_session(&mut store);
        let e1 = store
            .insert_explanation(NewExplanation {
                title: "first".to_string(),
                summary: None,
                mode: ExplanationMode::Diff,
                provider_session_id: "p1".to_string(),
                terminal_session_id: ts_id.clone(),
                repo_name: None,
            })
            .unwrap();
        let e2 = store
            .insert_explanation(NewExplanation {
                title: "second".to_string(),
                summary: None,
                mode: ExplanationMode::Topic,
                provider_session_id: "p2".to_string(),
                terminal_session_id: ts_id,
                repo_name: None,
            })
            .unwrap();
        assert_eq!(e1.id, "expl-1");
        assert_eq!(e2.id, "expl-2");
        assert_eq!(e2.mode, ExplanationMode::Topic);
    }
}
