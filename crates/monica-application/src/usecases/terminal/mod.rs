pub mod make_main;
pub mod ports;
pub mod query;
pub mod reconcile_terminal_sessions;
pub mod settle_terminal_exit;

pub use make_main::{make_main_by_terminal_tab, primary_terminal_tab, MakeMainOutcome};
pub use query::plan_path_for_terminal_tab;
pub use reconcile_terminal_sessions::{
    reconcile_terminal_sessions, DaemonSessionView, ReconcileOutcome, TerminalSessionUpdate,
};
pub use settle_terminal_exit::{
    task_run_settlement_for_orphaned_run, task_run_settlement_for_terminal_exit,
    TerminalExitSettlement,
};
