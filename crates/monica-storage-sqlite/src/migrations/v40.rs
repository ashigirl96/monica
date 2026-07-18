// NoteKind を内容分類（essay/journaling/memo）から取り出し方の3値（project/daily/essay）に
// 再設計する。不変条件: project は project_id 必須・title なし、daily はどちらもなし、
// essay は title 非 NULL（空 = 無題）・project_id なし。restore され得るので
// soft-delete 済みの行も対象にする。順序依存: project 昇格を確定させてから残りを掃く。
pub(super) const SQL: &str = r#"
    UPDATE notes SET kind = 'project', title = NULL
     WHERE kind = 'memo' AND project_id IS NOT NULL;
    UPDATE notes SET kind = 'daily', title = NULL, project_id = NULL
     WHERE kind IN ('memo', 'journaling');
    UPDATE notes SET title = COALESCE(title, ''), project_id = NULL
     WHERE kind = 'essay';
"#;

#[cfg(test)]
mod tests {
    use crate::migrations::test_support::stage_through;
    use rusqlite::Connection;

    #[test]
    fn rewrites_kinds_and_normalizes_invariants() {
        let mut conn = Connection::open_in_memory().unwrap();
        stage_through(&mut conn, 39);
        conn.execute(
            "INSERT INTO projects (id, name, repo) VALUES ('o/r', 'r', 'o/r')",
            [],
        )
        .unwrap();
        conn.execute_batch(
            "INSERT INTO notes (id, kind, title, project_id, deleted_at) VALUES
               ('note-1', 'memo', 'titled memo', 'o/r', NULL),
               ('note-2', 'memo', NULL, 'o/r', NULL),
               ('note-3', 'memo', 'inbox idea', NULL, NULL),
               ('note-4', 'memo', NULL, NULL, NULL),
               ('note-5', 'journaling', 'diary', 'o/r', NULL),
               ('note-6', 'journaling', NULL, NULL, NULL),
               ('note-7', 'essay', 'finished piece', 'o/r', NULL),
               ('note-8', 'essay', NULL, NULL, NULL),
               ('note-9', 'memo', 'deleted too', 'o/r', '2026-01-02T03:04:05.000Z');",
        )
        .unwrap();

        conn.execute_batch(super::SQL).unwrap();

        let row = |id: &str| -> (String, Option<String>, Option<String>) {
            conn.query_row(
                "SELECT kind, title, project_id FROM notes WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap()
        };

        // memo + project → project（title 破棄）
        assert_eq!(row("note-1"), ("project".into(), None, Some("o/r".into())));
        assert_eq!(row("note-2"), ("project".into(), None, Some("o/r".into())));
        // memo（project なし）→ daily（title 破棄）
        assert_eq!(row("note-3"), ("daily".into(), None, None));
        assert_eq!(row("note-4"), ("daily".into(), None, None));
        // journaling → daily（title / project 破棄）
        assert_eq!(row("note-5"), ("daily".into(), None, None));
        assert_eq!(row("note-6"), ("daily".into(), None, None));
        // essay → essay（title 非 NULL 化・project 紐付け破棄）
        assert_eq!(row("note-7"), ("essay".into(), Some("finished piece".into()), None));
        assert_eq!(row("note-8"), ("essay".into(), Some(String::new()), None));
        // soft-delete 済みの行も移行される
        assert_eq!(row("note-9"), ("project".into(), None, Some("o/r".into())));

        let violations: i64 = conn
            .query_row(
                "SELECT count(*) FROM notes
                 WHERE kind NOT IN ('project', 'daily', 'essay')
                    OR (kind <> 'project' AND project_id IS NOT NULL)
                    OR (kind = 'project' AND project_id IS NULL)
                    OR (kind <> 'essay' AND title IS NOT NULL)
                    OR (kind = 'essay' AND title IS NULL)",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(violations, 0);
    }
}
