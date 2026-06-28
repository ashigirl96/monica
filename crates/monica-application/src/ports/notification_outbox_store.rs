use anyhow::Result;
use monica_domain::{NewNotificationIntent, NotificationIntent};

pub trait NotificationOutboxStore {
    fn enqueue_notification(
        &mut self,
        intent: NewNotificationIntent,
    ) -> Result<NotificationIntent>;

    fn list_pending_notifications(&self, limit: usize) -> Result<Vec<NotificationIntent>>;

    fn mark_notification_delivered(&self, id: i64) -> Result<()>;

    fn mark_notification_failed(&self, id: i64, error: &str) -> Result<()>;
}
