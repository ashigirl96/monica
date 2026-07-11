use anyhow::Result;

use monica_domain::{Explanation, NewExplanation};

pub trait ExplanationStore {
    fn insert_explanation(&mut self, new: NewExplanation) -> Result<Explanation>;
    fn delete_explanation(&mut self, id: &str) -> Result<()>;
}
