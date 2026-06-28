use monica_domain::NotificationIntent;

use crate::error::ApplicationResult;
use crate::ports::NotificationOutboxStore;

use super::Backend;
use super::Monica;

pub struct NotificationService<'a, B: Backend> {
    pub(super) m: &'a mut Monica<B>,
}

impl<B: Backend> NotificationService<'_, B> {
    pub fn list_pending(&self, limit: usize) -> ApplicationResult<Vec<NotificationIntent>> {
        Ok(self.m.repos.list_pending_notifications(limit)?)
    }

    pub fn mark_delivered(&self, id: i64) -> ApplicationResult<()> {
        Ok(self.m.repos.mark_notification_delivered(id)?)
    }

    pub fn mark_failed(&self, id: i64, error: &str) -> ApplicationResult<()> {
        Ok(self.m.repos.mark_notification_failed(id, error)?)
    }
}
