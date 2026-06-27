use anyhow::Result;

use monica_domain::{Agent, AgentSignal};

/// Turns a raw agent hook payload into a provider-agnostic [`AgentSignal`]. This is the single point
/// where provider-specific event names and JSON layout are interpreted; everything downstream works
/// in typed signals. Implemented per agent in the adapter layer (`monica-adapters::agents`).
///
/// `Ok(None)` means the event is not actionable and must not be recorded at all (a non-blocking tool
/// call, an unparseable payload). A recorded-but-inert event (a notification, a recoverable failure)
/// returns `Ok(Some(_))` with [`monica_domain::SignalKind::Inert`].
pub trait AgentEventDecoder {
    fn decode(&self, raw: &[u8]) -> Result<Option<AgentSignal>>;
}

/// Selects the right per-agent [`AgentEventDecoder`] and exposes the opaque provider event name.
/// The façade decodes through this port so drivers never touch the concrete per-agent decoders —
/// raw hook bytes go straight into [`Monica`](crate::Monica) and the decode happens behind it.
pub trait AgentDecoders {
    fn decode(&self, agent: Agent, raw: &[u8]) -> Result<Option<AgentSignal>>;
    /// The opaque provider event name, recovered for logging an event the decoder declined to act
    /// on (a dropped non-blocking tool call). Keeps provider field knowledge out of the driver.
    fn event_label(&self, raw: &[u8]) -> Option<String>;
}
