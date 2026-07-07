mod record_hook;

pub use record_hook::{record_claude_session_hook, ClaudeHookReport};
pub(crate) use record_hook::label_is_state_neutral;
