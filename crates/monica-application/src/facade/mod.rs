//! The `Monica` application façade. Drivers (desktop, CLI, scheduler) hold a `Monica` and reach
//! every use case through a small set of service views, instead of assembling repositories and
//! gateways themselves. Each accessor borrows the façade for the duration of one call, so the
//! single SQLite connection backing `Repos` is used strictly serially.
//!
//! `Monica` is `!Send` (its SQLite store owns a non-`Send` connection): build a fresh one per
//! operation / per thread via the `monica-runtime` constructor — never share one across threads.

mod backend;
mod executions;
mod explanations;
mod notifications;
mod projects;
mod synchronization;
mod tasks;

pub use backend::Backend;
pub use executions::ExecutionService;
pub use explanations::ExplanationService;
pub use notifications::NotificationService;
pub use projects::{ProjectInit, ProjectService};
pub use synchronization::SynchronizationService;
pub use tasks::TaskService;

use crate::EventSink;

pub struct Monica<B: Backend> {
    pub(in crate::facade) repos: B::Repos,
    pub(in crate::facade) git: B::Git,
    pub(in crate::facade) github: B::Github,
    pub(in crate::facade) auth: B::Auth,
    pub(in crate::facade) setup: B::Setup,
    pub(in crate::facade) outputs: B::Outputs,
    pub(in crate::facade) workspace: B::Workspace,
    pub(in crate::facade) agents: B::Agents,
    pub(in crate::facade) events: Box<dyn EventSink>,
}

impl<B: Backend> Monica<B> {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        repos: B::Repos,
        git: B::Git,
        github: B::Github,
        auth: B::Auth,
        setup: B::Setup,
        outputs: B::Outputs,
        workspace: B::Workspace,
        agents: B::Agents,
        events: Box<dyn EventSink>,
    ) -> Self {
        Self { repos, git, github, auth, setup, outputs, workspace, agents, events }
    }

    pub fn tasks(&mut self) -> TaskService<'_, B> {
        TaskService { m: self }
    }

    pub fn executions(&mut self) -> ExecutionService<'_, B> {
        ExecutionService { m: self }
    }

    pub fn projects(&mut self) -> ProjectService<'_, B> {
        ProjectService { m: self }
    }

    pub fn synchronization(&mut self) -> SynchronizationService<'_, B> {
        SynchronizationService { m: self }
    }

    pub fn notifications(&mut self) -> NotificationService<'_, B> {
        NotificationService { m: self }
    }

    pub fn explanations(&mut self) -> ExplanationService<'_, B> {
        ExplanationService { m: self }
    }
}
