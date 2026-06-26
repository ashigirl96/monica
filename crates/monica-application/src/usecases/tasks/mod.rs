mod ports;

mod close_issue;
mod create_raw_task;
mod make_main;

pub use close_issue::{close_issue, CloseIssueReport};
pub use create_raw_task::create_raw_task;
pub use make_main::{make_main_by_terminal_tab, primary_terminal_tab, MakeMainOutcome};
