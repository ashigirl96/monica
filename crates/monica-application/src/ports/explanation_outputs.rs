use std::path::PathBuf;

use anyhow::Result;

pub trait ExplanationOutputs {
    fn write_scaffold(&self, explanation_id: &str, title: &str) -> Result<PathBuf>;
    fn remove_dir(&self, explanation_id: &str) -> Result<()>;
}
