mod ports;

mod attach_session;
mod close_task;
mod create_raw_task;
mod current_task;
mod make_main;
mod tab_identity;

pub use attach_session::{
    attach_terminal_session_to_task, list_tab_task_bindings, AttachSessionReport, TabTaskBinding,
};
pub use close_task::{close_task, CloseTaskReport};
pub use current_task::{resolve_current_task, CurrentTaskReport, CurrentTaskSource};
pub use tab_identity::TabIdentity;
pub use create_raw_task::create_raw_task;
pub use make_main::{
    make_main_by_terminal_tab, primary_agent_session_id, primary_terminal_tab, MakeMainOutcome,
};
pub(crate) use make_main::primary_run;
