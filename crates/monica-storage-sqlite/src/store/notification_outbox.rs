use anyhow::Result;
use rusqlite::{params, Connection};

use monica_domain::{NewNotificationIntent, NotificationIntent};

use super::NOTIFICATION_OUTBOX_COLUMNS;
use crate::row::notification_intent_from_row;

const MAX_ATTEMPTS: i64 = 5;

pub(crate) fn enqueue_notification_in(
    conn: &Connection,
    intent: NewNotificationIntent,
) -> Result<NotificationIntent> {
    conn.execute(
        "INSERT INTO notification_outbox
           (dedupe_key, kind, title, body, task_id, task_run_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(dedupe_key) DO UPDATE SET
           title = excluded.title,
           body = excluded.body,
           delivered_at = NULL,
           error = NULL,
           attempts = 0",
        params![
            intent.dedupe_key,
            intent.kind.as_str(),
            intent.title,
            intent.body,
            intent.task_id,
            intent.task_run_id,
        ],
    )?;

    let mut stmt = conn.prepare(&format!(
        "SELECT {NOTIFICATION_OUTBOX_COLUMNS} FROM notification_outbox WHERE dedupe_key = ?1"
    ))?;
    let mut rows = stmt.query(params![intent.dedupe_key])?;
    match rows.next()? {
        Some(row) => Ok(notification_intent_from_row(row)?),
        None => anyhow::bail!("notification not found after enqueue"),
    }
}

pub(crate) fn list_pending_notifications_in(
    conn: &Connection,
    limit: usize,
) -> Result<Vec<NotificationIntent>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {NOTIFICATION_OUTBOX_COLUMNS} FROM notification_outbox
         WHERE delivered_at IS NULL AND attempts < ?1
         ORDER BY created_at
         LIMIT ?2"
    ))?;
    let mut result = Vec::new();
    let mut rows = stmt.query(params![MAX_ATTEMPTS, limit as i64])?;
    while let Some(row) = rows.next()? {
        result.push(notification_intent_from_row(row)?);
    }
    Ok(result)
}

pub(crate) fn mark_notification_delivered_in(conn: &Connection, id: i64) -> Result<()> {
    conn.execute(
        "DELETE FROM notification_outbox WHERE id = ?1",
        params![id],
    )?;
    Ok(())
}

pub(crate) fn cancel_notifications_for_run_in(
    conn: &Connection,
    task_run_id: &str,
) -> Result<()> {
    conn.execute(
        "DELETE FROM notification_outbox WHERE task_run_id = ?1",
        params![task_run_id],
    )?;
    Ok(())
}

pub(crate) fn mark_notification_failed_in(
    conn: &Connection,
    id: i64,
    error: &str,
) -> Result<()> {
    conn.execute(
        "UPDATE notification_outbox SET attempts = attempts + 1, error = ?2 WHERE id = ?1",
        params![id, error],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use monica_domain::NotificationKind;

    use super::*;
    use crate::SqliteStore;

    fn test_store() -> SqliteStore {
        SqliteStore::open_in_memory().unwrap()
    }

    fn sample_intent() -> NewNotificationIntent {
        NewNotificationIntent {
            dedupe_key: "awaiting_user_input:run-1".to_string(),
            kind: NotificationKind::AwaitingUserInput,
            title: "Monica".to_string(),
            body: "入力待ち".to_string(),
            task_id: Some("MON-1".to_string()),
            task_run_id: Some("run-1".to_string()),
        }
    }

    #[test]
    fn enqueue_and_list_pending() {
        use monica_application::NotificationOutboxStore;
        let mut store = test_store();
        let intent = store.enqueue_notification(sample_intent()).unwrap();
        assert_eq!(intent.kind, NotificationKind::AwaitingUserInput);
        assert_eq!(intent.body, "入力待ち");
        assert!(intent.delivered_at.is_none());

        let pending = store.list_pending_notifications(10).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].id, intent.id);
    }

    #[test]
    fn dedup_ignores_second_enqueue() {
        use monica_application::NotificationOutboxStore;
        let mut store = test_store();
        store.enqueue_notification(sample_intent()).unwrap();
        store.enqueue_notification(sample_intent()).unwrap();

        let pending = store.list_pending_notifications(10).unwrap();
        assert_eq!(pending.len(), 1);
    }

    #[test]
    fn mark_delivered_removes_from_pending() {
        use monica_application::NotificationOutboxStore;
        let mut store = test_store();
        let intent = store.enqueue_notification(sample_intent()).unwrap();

        store.mark_notification_delivered(intent.id).unwrap();

        let pending = store.list_pending_notifications(10).unwrap();
        assert!(pending.is_empty());
    }

    #[test]
    fn mark_failed_increments_attempts() {
        use monica_application::NotificationOutboxStore;
        let mut store = test_store();
        let intent = store.enqueue_notification(sample_intent()).unwrap();

        store
            .mark_notification_failed(intent.id, "permission denied")
            .unwrap();

        let pending = store.list_pending_notifications(10).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].attempts, 1);
        assert_eq!(pending[0].error.as_deref(), Some("permission denied"));
    }

    #[test]
    fn re_enqueue_after_delivery_creates_new_pending() {
        use monica_application::NotificationOutboxStore;
        let mut store = test_store();
        let intent = store.enqueue_notification(sample_intent()).unwrap();
        store.mark_notification_delivered(intent.id).unwrap();

        assert!(store.list_pending_notifications(10).unwrap().is_empty());

        let re_enqueued = store.enqueue_notification(sample_intent()).unwrap();
        assert_eq!(re_enqueued.attempts, 0);

        let pending = store.list_pending_notifications(10).unwrap();
        assert_eq!(pending.len(), 1);
    }

    #[test]
    fn cancel_removes_notifications_for_run() {
        use monica_application::NotificationOutboxStore;
        let mut store = test_store();
        store.enqueue_notification(sample_intent()).unwrap();

        store.cancel_notifications_for_run("run-1").unwrap();

        let pending = store.list_pending_notifications(10).unwrap();
        assert!(pending.is_empty());
    }

    #[test]
    fn exceeded_max_attempts_excluded_from_pending() {
        use monica_application::NotificationOutboxStore;
        let mut store = test_store();
        let intent = store.enqueue_notification(sample_intent()).unwrap();

        for _ in 0..super::MAX_ATTEMPTS {
            store
                .mark_notification_failed(intent.id, "permission denied")
                .unwrap();
        }

        let pending = store.list_pending_notifications(10).unwrap();
        assert!(pending.is_empty(), "notification with max attempts should be excluded");
    }
}
