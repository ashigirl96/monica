use crate::{ApplicationError, ApplicationResult};

/// The `MONICA_*` identity a Monica terminal tab burns into its shell env, as a driver reads it
/// out of the environment. Drivers own the reading; the acceptance rules live here so `attach`
/// and `current` cannot drift apart on what counts as a Monica tab.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TabIdentity {
    pub task_id: Option<String>,
    pub terminal_tab_id: Option<String>,
    pub terminal_session_id: Option<String>,
}

impl TabIdentity {
    /// The (tab, session) pair `attach` binds. A tab carrying `MONICA_TASK_ID` is already bound to
    /// that task and its hooks resolve through the task-scoped rules, so a run attached here would
    /// never receive one — refuse instead of leaving a silently dead binding behind.
    pub fn attach_target(&self) -> ApplicationResult<(&str, &str)> {
        if let Some(task_id) = self.task_id.as_deref() {
            return Err(ApplicationError::validation(format!(
                "this tab is already bound to task {task_id}; attach is for tabs started outside a task"
            )));
        }
        let (Some(tab_id), Some(session_id)) =
            (self.terminal_tab_id.as_deref(), self.terminal_session_id.as_deref())
        else {
            return Err(Self::no_tab());
        };
        Ok((tab_id, session_id))
    }

    /// Whether this identity names a Monica tab at all — either id is enough, since a session can
    /// be resolved back to the tab that owns it.
    pub fn is_monica_tab(&self) -> bool {
        self.terminal_tab_id.is_some() || self.terminal_session_id.is_some()
    }

    pub(super) fn no_tab() -> ApplicationError {
        ApplicationError::validation("no Monica terminal tab detected; run this inside a Monica terminal tab")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity(task: Option<&str>, tab: Option<&str>, session: Option<&str>) -> TabIdentity {
        TabIdentity {
            task_id: task.map(str::to_string),
            terminal_tab_id: tab.map(str::to_string),
            terminal_session_id: session.map(str::to_string),
        }
    }

    #[test]
    fn attach_target_reads_the_tab_identity_from_a_task_less_tab() {
        let identity = identity(None, Some("tab-1"), Some("ts-9"));
        assert_eq!(identity.attach_target().unwrap(), ("tab-1", "ts-9"));
    }

    #[test]
    fn attach_target_refuses_a_tab_already_bound_to_a_task() {
        let err = identity(Some("MON-1"), Some("tab-1"), Some("ts-9"))
            .attach_target()
            .unwrap_err();
        assert!(err.to_string().contains("already bound to task MON-1"), "{err}");
    }

    #[test]
    fn attach_target_refuses_a_tab_missing_either_id() {
        for identity in [
            identity(None, Some("tab-1"), None),
            identity(None, None, Some("ts-9")),
            identity(None, None, None),
        ] {
            let err = identity.attach_target().unwrap_err();
            assert!(err.to_string().contains("no Monica terminal tab detected"), "{err}");
        }
    }

    #[test]
    fn is_monica_tab_accepts_either_id_alone() {
        assert!(identity(None, Some("tab-1"), None).is_monica_tab());
        assert!(identity(None, None, Some("ts-9")).is_monica_tab());
        assert!(!identity(Some("MON-1"), None, None).is_monica_tab());
    }
}
