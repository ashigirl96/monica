use anyhow::Result;
use monica_application::ports::ExplanationStore;
use monica_domain::{Explanation, ExplanationId, ExplanationMode, NewExplanation};
use rusqlite::{params, Row};

use crate::SqliteStore;

use super::EXPLANATION_COLUMNS;

fn explanation_from_row(row: &Row<'_>) -> Result<Explanation> {
    let mode: String = row.get("mode")?;
    Ok(Explanation {
        id: ExplanationId::from_store(row.get("id")?),
        title: row.get("title")?,
        mode: mode.parse::<ExplanationMode>()?,
        provider_session_id: row.get("provider_session_id")?,
        terminal_session_id: row.get("terminal_session_id")?,
        created_at: row.get("created_at")?,
    })
}

fn insert_explanation_in(
    conn: &rusqlite::Connection,
    new: NewExplanation,
) -> Result<Explanation> {
    conn.execute("INSERT INTO explanation_counter DEFAULT VALUES", [])?;
    let id = format!("expl-{}", conn.last_insert_rowid());
    conn.execute(
        "INSERT INTO explanations (id, title, mode, provider_session_id, terminal_session_id)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            id,
            new.title,
            new.mode.as_str(),
            new.provider_session_id,
            new.terminal_session_id,
        ],
    )?;
    let mut stmt = conn.prepare(&format!(
        "SELECT {EXPLANATION_COLUMNS} FROM explanations WHERE id = ?1"
    ))?;
    let mut rows = stmt.query(params![id])?;
    let row = rows.next()?.expect("just inserted");
    explanation_from_row(row)
}

impl ExplanationStore for SqliteStore {
    fn insert_explanation(&mut self, new: NewExplanation) -> Result<Explanation> {
        let tx = self.conn_mut().transaction()?;
        let explanation = insert_explanation_in(&tx, new)?;
        tx.commit()?;
        Ok(explanation)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use monica_domain::{NewTerminalSession, TerminalSessionKind};

    fn seed_terminal_session(store: &mut SqliteStore) -> String {
        let session = store
            .create_terminal_session(NewTerminalSession {
                runspace_id: None,
                tab_id: None,
                kind: TerminalSessionKind::Shell,
                cwd: "/tmp".to_string(),
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
                mode: ExplanationMode::Diff,
                provider_session_id: "provider-123".to_string(),
                terminal_session_id: ts_id.clone(),
            })
            .unwrap();
        assert_eq!(explanation.id, "expl-1");
        assert_eq!(explanation.title, "test explanation");
        assert_eq!(explanation.mode, ExplanationMode::Diff);
        assert_eq!(explanation.provider_session_id, "provider-123");
        assert_eq!(explanation.terminal_session_id, ts_id);
        assert!(!explanation.created_at.is_empty());
    }

    #[test]
    fn insert_with_invalid_terminal_session_fails() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        let result = store.insert_explanation(NewExplanation {
            title: "orphan".to_string(),
            mode: ExplanationMode::Diff,
            provider_session_id: "p1".to_string(),
            terminal_session_id: "ts-nonexistent".to_string(),
        });
        assert!(result.is_err());
    }

    #[test]
    fn ids_increment() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        let ts_id = seed_terminal_session(&mut store);
        let e1 = store
            .insert_explanation(NewExplanation {
                title: "first".to_string(),
                mode: ExplanationMode::Diff,
                provider_session_id: "p1".to_string(),
                terminal_session_id: ts_id.clone(),
            })
            .unwrap();
        let e2 = store
            .insert_explanation(NewExplanation {
                title: "second".to_string(),
                mode: ExplanationMode::Topic,
                provider_session_id: "p2".to_string(),
                terminal_session_id: ts_id,
            })
            .unwrap();
        assert_eq!(e1.id, "expl-1");
        assert_eq!(e2.id, "expl-2");
        assert_eq!(e2.mode, ExplanationMode::Topic);
    }
}
