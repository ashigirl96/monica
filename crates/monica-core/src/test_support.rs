//! Test helpers shared across modules in this crate.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// Pid + monotonic counter + nanosecond stamp keep parallel-thread tests from colliding even when
/// `cargo test` runs them concurrently in the same process.
pub(crate) fn unique_tmp(tag: &str) -> PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    let n = N.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let p = std::env::temp_dir().join(format!(
        "monica-test-{tag}-{}-{nanos}-{n}",
        std::process::id()
    ));
    fs::create_dir_all(&p).unwrap();
    p
}

pub(crate) struct Tmp(PathBuf);

impl Tmp {
    pub(crate) fn new(tag: &str) -> Self {
        Tmp(unique_tmp(tag))
    }

    pub(crate) fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
