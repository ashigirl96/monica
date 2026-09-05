mod support;

mod facade;
mod github;
mod projects;
mod tasks;

mod runs;

use std::path::{Path, PathBuf};

use crate::ports::{
    TaskRunStore, TaskStore, TerminalSessionRepository, WorkbenchStore,
};
use super::runs::record_hook::{
    resolve_by_lazy_create, resolve_by_prepared_primary, resolve_by_session, RunResolveCtx,
};
use crate::usecases::github::{github_auth_status, track_github_issue};
use crate::usecases::projects::register_project_with_default_branch;
use crate::usecases::runs::{execute_run, open_bench, run_task, start_run};
use crate::usecases::tasks::{
    attach_terminal_session_to_task, close_task, create_raw_task, make_main_by_terminal_tab,
    primary_terminal_tab,
};
use crate::prelude::{
    Agent, AgentSessionStatus, AgentSignal, Continuation, ExplanationMode, NewTaskRun,
    NewTerminalSession, Project,
    Provider, RefType, SignalKind, TaskId, TaskRunStatus, TaskRunWaitReason, TaskStatus,
    TerminalSession, TerminalSessionKind, TerminalSessionStatus,
};
use crate::{
    ApplicationError, ApplicationEvent, HookContext, PullRequestBranchSyncCandidate,
    SetupOutcome, TaskBench,
};
