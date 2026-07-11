use std::path::PathBuf;

use monica_domain::{Explanation, ExplanationId, ExplanationMode, NewExplanation};

use crate::error::{ApplicationError, ApplicationResult};
use crate::ports::{ExplanationOutputs, ExplanationStore, TerminalSessionRepository};
use super::Backend;

pub struct ExplanationService<'a, B: Backend> {
    pub(in crate::facade) m: &'a mut super::Monica<B>,
}

impl<B: Backend> ExplanationService<'_, B> {
    pub fn list_explanations(&mut self) -> ApplicationResult<Vec<Explanation>> {
        Ok(self.m.repos.list_explanations()?)
    }

    pub fn get_explanation(&mut self, id: &str) -> ApplicationResult<Explanation> {
        ExplanationId::parse(id)?;
        self.m
            .repos
            .get_explanation(id)?
            .ok_or_else(|| ApplicationError::not_found(format!("explanation {id} not found")))
    }

    pub fn delete_explanation(&mut self, id: &str) -> ApplicationResult<()> {
        self.get_explanation(id)?;
        self.m.outputs.remove_dir(id)?;
        self.m.repos.delete_explanation(id)?;
        Ok(())
    }

    pub fn create_explanation(
        &mut self,
        terminal_session_id: &str,
        title: &str,
        mode: ExplanationMode,
    ) -> ApplicationResult<(Explanation, PathBuf)> {
        let session = self
            .m
            .repos
            .get_terminal_session(terminal_session_id)?
            .ok_or_else(|| {
                ApplicationError::not_found(format!(
                    "terminal session {terminal_session_id} not found"
                ))
            })?;

        let provider_session_id =
            session.provider_session_id.ok_or_else(|| {
                ApplicationError::validation(format!(
                    "terminal session {terminal_session_id} has no active agent session \
                     (provider_session_id is null)"
                ))
            })?;

        let explanation = self.m.repos.insert_explanation(NewExplanation {
            title: title.to_string(),
            mode,
            provider_session_id,
            terminal_session_id: terminal_session_id.to_string(),
        })?;

        let index_path = match self
            .m
            .outputs
            .write_scaffold(explanation.id.as_str(), title)
        {
            Ok(path) => path,
            Err(e) => {
                let _ = self.m.repos.delete_explanation(explanation.id.as_str());
                return Err(e.into());
            }
        };

        Ok((explanation, index_path))
    }
}
