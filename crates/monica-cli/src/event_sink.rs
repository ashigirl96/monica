use monica_application::{ApplicationEvent, EventSink, notification};

use crate::notify;

/// The application façade wired to the CLI's default backend and event sink.
pub type CliFacade = monica_runtime::MonicaFacade;

/// Open the façade for a CLI command, routing application events to the CLI sink.
pub fn open() -> anyhow::Result<CliFacade> {
    monica_runtime::open_monica(Box::new(CliEventSink))
}

/// Routes application events to the CLI's surface. By default, `AwaitingUserInput` is a no-op
/// because the Desktop outbox worker handles delivery. Set
/// `MONICA_CLI_NOTIFICATION_FALLBACK=osascript` to re-enable the legacy macOS notification.
pub struct CliEventSink;

impl EventSink for CliEventSink {
    fn emit(&self, event: ApplicationEvent) {
        match event {
            ApplicationEvent::AwaitingUserInput { reason, task_title, .. } => {
                if std::env::var("MONICA_CLI_NOTIFICATION_FALLBACK")
                    .ok()
                    .as_deref()
                    == Some("osascript")
                {
                    let body =
                        notification::waiting_notification(reason, task_title.as_deref());
                    notify::post(notification::TITLE, &body);
                }
            }
            ApplicationEvent::TaskRunStatusChanged { .. }
            | ApplicationEvent::PullRequestSyncCompleted { .. } => {}
        }
    }
}
