mod ports;

mod attach_session;
mod close_task;
mod create_raw_task;
mod make_main;

pub use attach_session::{
    attach_terminal_session_to_task, list_tab_task_bindings, AttachSessionReport, TabTaskBinding,
};
pub use close_task::{close_task, CloseTaskReport};
pub use create_raw_task::create_raw_task;
pub use make_main::{make_main_by_terminal_tab, primary_terminal_tab, MakeMainOutcome};
