use anyhow::Result;

use monica_domain::AgentSignal;

/// Turns a raw agent hook payload into a provider-agnostic [`AgentSignal`]. This is the single point
/// where provider-specific event names and JSON layout are interpreted; everything downstream works
/// in typed signals. Implemented per agent in the adapter layer (`monica-infra::agents`).
///
/// `Ok(None)` means the event is not actionable and must not be recorded at all (a non-blocking tool
/// call, an unparseable payload). A recorded-but-inert event (a notification, a recoverable failure)
/// returns `Ok(Some(_))` with [`monica_domain::SignalKind::Inert`].
pub trait AgentEventDecoder {
    fn decode(&self, raw: &[u8]) -> Result<Option<AgentSignal>>;
}
