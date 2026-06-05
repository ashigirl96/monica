use std::future::Future;
use std::pin::Pin;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

mod agent_launcher;
mod auth_gateway;
mod clock;
mod event_repository;
mod git_gateway;
mod github_gateway;
mod project_repository;
mod run_artifacts;
mod setup_runner;
mod task_repository;
mod task_run_repository;

pub use agent_launcher::{AgentLaunch, AgentLaunchMode, AgentLauncher};
pub use auth_gateway::AuthGateway;
pub use clock::Clock;
pub use event_repository::EventRepository;
pub use git_gateway::GitGateway;
pub use github_gateway::GithubGateway;
pub use project_repository::ProjectRepository;
pub use run_artifacts::RunArtifacts;
pub use setup_runner::{SetupEnv, SetupOutcome, SetupRunner};
pub use task_repository::TaskRepository;
pub use task_run_repository::TaskRunRepository;
