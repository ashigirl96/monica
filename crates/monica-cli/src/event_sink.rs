use monica_application::{ApplicationEvent, EventSink};

use crate::notify;

/// The application façade wired to the CLI's default backend and event sink.
pub type CliFacade = monica_runtime::MonicaFacade;

/// Open the façade for a CLI command, routing application events to the CLI sink.
pub fn open() -> anyhow::Result<CliFacade> {
    monica_runtime::open_monica(Box::new(CliEventSink))
}

/// Routes application events to the CLI's surface: a waiting run fires an OS notification; status
/// and PR-sync events are conveyed by command output, not here.
pub struct CliEventSink;

impl EventSink for CliEventSink {
    fn emit(&self, event: ApplicationEvent) {
        match event {
            ApplicationEvent::AwaitingUserInput { reason, task_title, .. } => {
                notify::post(&notify::waiting_notification(reason, task_title.as_deref()));
            }
            ApplicationEvent::TaskRunStatusChanged { .. }
            | ApplicationEvent::PullRequestSyncCompleted { .. } => {}
        }
    }
}
