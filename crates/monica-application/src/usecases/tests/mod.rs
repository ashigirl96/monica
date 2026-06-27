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
use crate::usecases::{
    begin_github_device_flow, close_issue, create_raw_task, execute_run, github_auth_status,
    logout_github, make_main_by_terminal_tab, open_bench, prepare_claude_for_run,
    primary_terminal_tab, register_project_with_default_branch, start_run, sync_next_pull_request,
    track_github_issue, wait_for_github_device_flow,
};
use crate::{
    Agent, AgentSignal, ApplicationError, ApplicationEvent, Continuation, HookContext,
    MakeMainOutcome, NewTerminalSession, NewTaskRun, Project, PullRequestBranchSyncCandidate, TaskId,
    PullRequestSyncStatus, Provider, RefType, SetupOutcome, SignalKind, TaskBench, TaskRunStatus,
    TaskRunWaitReason, TaskStatus, TerminalSessionKind, TerminalSessionStatus, TrackGithubIssueInput,
};
