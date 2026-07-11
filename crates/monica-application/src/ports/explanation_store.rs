use anyhow::Result;

use monica_domain::{Explanation, NewExplanation};

pub trait ExplanationStore {
    fn list_explanations(&self) -> Result<Vec<Explanation>>;
    fn get_explanation(&self, id: &str) -> Result<Option<Explanation>>;
    fn insert_explanation(&mut self, new: NewExplanation) -> Result<Explanation>;
    fn delete_explanation(&mut self, id: &str) -> Result<()>;
}
