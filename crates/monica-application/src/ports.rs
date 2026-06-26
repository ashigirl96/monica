//! Aggregate facade over the per-context ports. Each port trait is defined co-located with the
//! use cases that own it (`usecases/<context>/ports.rs`); this module re-exports them so the
//! crate's flat public API (`monica_application::TaskRepository`, …) and the `crate::ports::*`
//! path stay stable.

use std::future::Future;
use std::pin::Pin;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub use crate::usecases::github::ports::{AuthGateway, GithubGateway};
pub use crate::usecases::projects::ports::ProjectRepository;
pub use crate::usecases::runs::ports::{
    BenchRepository, Clock, GitGateway, SetupEnv, SetupOutcome, SetupRunner, TaskRunOutputs,
    TaskRunRepository, TaskShellEnv,
};
pub use crate::usecases::tasks::ports::{EventRepository, TaskRepository, TaskSummaryFilter};
