/// v34: track whether subagents are still running when a Claude session goes idle.
///
/// The hook-driven `TurnCompleted { subagents_running }` signal already carries this
/// information, but the session row had no place to persist it. SDK clients need it to
/// distinguish "turn truly complete" from "temporarily idle while forks run".
pub(super) const SQL: &str = "
ALTER TABLE claude_sessions ADD COLUMN subagents_running INTEGER NOT NULL DEFAULT 0;
";
