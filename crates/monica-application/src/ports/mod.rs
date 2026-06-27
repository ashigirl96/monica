use std::future::Future;
use std::pin::Pin;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

mod agent_event_decoder;
mod event_repository;
mod git_gateway;
mod notebook_gateway;
mod project_repository;
mod pull_request_sync;
mod task_board_query;
mod task_run_store;
mod task_store;
mod terminal_daemon;
mod terminal_session_repository;
mod unit_of_work;
mod workbench_store;
mod workspace;

pub use agent_event_decoder::{AgentDecoders, AgentEventDecoder};
pub use event_repository::EventRepository;
pub use git_gateway::{GitGateway, WorktreeRef};
pub use notebook_gateway::NotebookGateway;
pub use project_repository::ProjectRepository;
pub use pull_request_sync::PullRequestSyncStore;
pub use task_board_query::{TaskBoardQuery, TaskSummaryFilter};
pub use task_run_store::TaskRunStore;
pub use task_store::TaskStore;
pub use terminal_daemon::{TerminalAttachment, TerminalCreateRequest, TerminalDaemon};
pub use terminal_session_repository::TerminalSessionRepository;
pub use unit_of_work::{UnitOfWork, WorkTransaction};
pub use workbench_store::WorkbenchStore;
pub use workspace::Workspace;
