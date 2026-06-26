use anyhow::Result;

pub trait Clock {
    fn now_iso(&self) -> Result<String>;
}
