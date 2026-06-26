// 端末セッションのユースケースは port を注入しない純粋関数のみで、依存する port trait が無いため
// 他 context と異なり ports.rs を持たない。
mod reconcile_terminal_sessions;
mod settle_terminal_exit;

pub use reconcile_terminal_sessions::{
    reconcile_terminal_sessions, DaemonSessionView, ReconcileOutcome, TerminalSessionUpdate,
};
pub use settle_terminal_exit::{
    task_run_settlement_for_orphaned_run, task_run_settlement_for_terminal_exit,
    TerminalExitSettlement,
};
