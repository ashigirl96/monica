use std::path::Path;

use monica_domain::{Explanation, ExplanationMode, NewExplanation};

use super::{Backend, Monica};
use crate::ports::{ExplanationRepository, TerminalSessionRepository};
use crate::{ApplicationError, ApplicationResult};

pub struct ExplanationService<'a, B: Backend> {
    pub(in crate::facade) m: &'a mut Monica<B>,
}

impl<B: Backend> ExplanationService<'_, B> {
    pub fn create_topic(
        &mut self,
        title: &str,
        terminal_session_id: &str,
        artifact_root: &Path,
    ) -> ApplicationResult<Explanation> {
        let title = title.trim();
        if title.is_empty() {
            return Err(ApplicationError::validation("explanation title must not be empty"));
        }

        let terminal_session_id = terminal_session_id.trim();
        if terminal_session_id.is_empty() {
            return Err(ApplicationError::validation(
                "MONICA_TERMINAL_SESSION_ID must not be empty",
            ));
        }

        let session = self
            .m
            .repos
            .get_terminal_session(terminal_session_id)?
            .ok_or_else(|| {
                ApplicationError::not_found(format!(
                    "terminal session `{terminal_session_id}` not found"
                ))
            })?;
        let provider_session_id = session
            .provider_session_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| {
                ApplicationError::conflict(format!(
                    "terminal session `{terminal_session_id}` has no provider session id"
                ))
            })?
            .to_string();

        Ok(self.m.repos.create_explanation(
            NewExplanation {
                title: title.to_string(),
                mode: ExplanationMode::Topic,
                provider_session_id,
                terminal_session_id: terminal_session_id.to_string(),
            },
            artifact_root,
        )?)
    }

    pub fn list_explanations(&self) -> ApplicationResult<Vec<Explanation>> {
        Ok(self.m.repos.list_explanations()?)
    }

    pub fn get_explanation(&self, id: &str) -> ApplicationResult<Option<Explanation>> {
        Ok(self.m.repos.get_explanation(id)?)
    }
}
