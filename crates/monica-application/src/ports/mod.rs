use std::future::Future;
use std::pin::Pin;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

mod event_repository;
mod git_gateway;
mod notebook_gateway;
mod project_repository;
mod task_repository;
mod task_run_repository;
mod terminal_daemon;
mod terminal_session_repository;
mod workspace;

pub use event_repository::EventRepository;
pub use git_gateway::GitGateway;
pub use notebook_gateway::NotebookGateway;
pub use project_repository::ProjectRepository;
pub use task_repository::{TaskRepository, TaskSummaryFilter};
pub use task_run_repository::TaskRunRepository;
pub use terminal_daemon::{TerminalAttachment, TerminalCreateRequest, TerminalDaemon};
pub use terminal_session_repository::TerminalSessionRepository;
pub use workspace::Workspace;
