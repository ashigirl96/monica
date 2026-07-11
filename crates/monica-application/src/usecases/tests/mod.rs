mod support;

mod facade;
mod github;
mod projects;
mod tasks;

mod runs;

use std::path::{Path, PathBuf};

use crate::ports::{
    TaskRunStore, TaskStore, WorkbenchStore,
};
use super::runs::record_hook::{
    resolve_by_lazy_create, resolve_by_prepared_primary, resolve_by_session, RunResolveCtx,
};
use crate::usecases::github::{begin_github_device_flow, github_auth_status, logout_github, sync_next_pull_request, track_github_issue, wait_for_github_device_flow};
use crate::usecases::projects::register_project_with_default_branch;
use crate::usecases::runs::{execute_run, open_bench, prepare_claude_for_run, start_run};
use crate::usecases::tasks::{close_issue, create_raw_task, make_main_by_terminal_tab, primary_terminal_tab};
use crate::prelude::{
    Agent, AgentSignal, Continuation, ExplanationMode, NewTaskRun, NewTerminalSession, Project,
    Provider, RefType, SignalKind, TaskId, TaskRunStatus, TaskRunWaitReason, TaskStatus,
    TerminalSession, TerminalSessionKind, TerminalSessionStatus,
};
use crate::{
    ApplicationError, ApplicationEvent, HookContext, PullRequestBranchSyncCandidate,
    PullRequestSyncStatus, SetupOutcome, TaskBench,
};
