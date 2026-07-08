use monica_application::{ApplicationEvent, EventSink};

/// The application façade wired to the CLI's default backend and event sink.
pub type CliFacade = monica_runtime::MonicaFacade;

/// Open the façade for a CLI command, routing application events to the CLI sink.
pub fn open() -> anyhow::Result<CliFacade> {
    monica_runtime::open_monica(Box::new(CliEventSink))
}

/// Application events need no CLI-side delivery: the Desktop outbox worker owns
/// user-facing notifications.
pub struct CliEventSink;

impl EventSink for CliEventSink {
    fn emit(&self, _event: ApplicationEvent) {}
}
