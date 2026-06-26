use std::future::Future;
use std::pin::Pin;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

mod event_repository;
mod git_gateway;
mod project_repository;
mod task_repository;
mod task_run_repository;

pub use event_repository::EventRepository;
pub use git_gateway::GitGateway;
pub use project_repository::ProjectRepository;
pub use task_repository::{TaskRepository, TaskSummaryFilter};
pub use task_run_repository::TaskRunRepository;
