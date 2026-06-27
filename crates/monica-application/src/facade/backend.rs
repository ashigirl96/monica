use crate::ports::{
    AgentDecoders, EventRepository, GitGateway, NotebookGateway, ProjectRepository,
    PullRequestSyncStore, TaskBoardQuery, TaskRunStore, TaskStore, TerminalSessionRepository,
    UnitOfWork, WorkbenchStore, Workspace,
};
use crate::usecases::github::ports::{AuthGateway, GithubGateway};
use crate::usecases::runs::ports::{Clock, SetupRunner, TaskRunOutputs};

/// The set of concrete adapters the [`Monica`](super::Monica) façade is built over. Keeping this
/// as one associated-type trait lets `Monica` take a single type parameter while the application
/// stays free of any infra type (the impl lives in `monica-runtime`). A single `Repos` value backs
/// all repository ports — Monica's SQLite store implements them together.
pub trait Backend {
    type Repos: TaskStore
        + TaskBoardQuery
        + PullRequestSyncStore
        + TaskRunStore
        + ProjectRepository
        + EventRepository
        + WorkbenchStore
        + TerminalSessionRepository
        + Clock
        + UnitOfWork;
    type Git: GitGateway;
    type Github: GithubGateway;
    type Auth: AuthGateway;
    type Setup: SetupRunner;
    type Outputs: TaskRunOutputs;
    type Notebooks: NotebookGateway;
    type Workspace: Workspace;
    type Agents: AgentDecoders;
}
