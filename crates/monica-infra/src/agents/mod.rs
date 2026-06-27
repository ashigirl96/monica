//! Agent adapters: the single place that knows a provider's hook protocol. Decoders translate raw
//! hook payloads into the provider-agnostic [`AgentSignal`](monica_application::AgentSignal); the
//! config functions describe which events to register and where. Adding a new agent means adding a
//! decoder here, not touching the domain state machine or the stores.

mod config;
mod decode;

pub use config::{extra_hook_events, hooks_config_path};
pub use decode::{decoder_for, event_label, ClaudeEventDecoder, CodexEventDecoder};
