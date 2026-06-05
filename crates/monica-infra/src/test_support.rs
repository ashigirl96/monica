use std::path::{Path, PathBuf};

pub struct Tmp {
    path: PathBuf,
}

impl Tmp {
    pub fn new(tag: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "monica-infra-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        Self { path }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}
