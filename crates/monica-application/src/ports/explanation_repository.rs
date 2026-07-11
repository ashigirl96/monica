use std::path::Path;

use anyhow::Result;
use monica_domain::{Explanation, NewExplanation};

pub trait ExplanationRepository {
    fn create_explanation(
        &mut self,
        new: NewExplanation,
        artifact_root: &Path,
    ) -> Result<Explanation>;

    fn list_explanations(&self) -> Result<Vec<Explanation>>;

    fn get_explanation(&self, id: &str) -> Result<Option<Explanation>>;
}
