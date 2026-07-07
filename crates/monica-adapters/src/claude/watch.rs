use std::path::Path;

use anyhow::{Context, Result};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};

/// FSEvents-backed watcher over Claude Code's per-project transcript directories.
/// Watches directories rather than files: the `.jsonl` is created lazily on the first
/// user message, and a directory watch sees that creation where a file watch could not.
pub struct FsJsonlWatcher {
    watcher: RecommendedWatcher,
}

impl FsJsonlWatcher {
    /// `on_jsonl_event` fires with the path of every `.jsonl` created or modified under a
    /// watched directory, from the watcher's own thread — it must not block.
    pub fn new(on_jsonl_event: Box<dyn Fn(&Path) + Send>) -> Result<Self> {
        let watcher = notify::recommended_watcher(move |res: notify::Result<Event>| match res {
            Ok(event) => {
                if !matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_)) {
                    return;
                }
                for path in &event.paths {
                    if path.extension().is_some_and(|ext| ext == "jsonl") {
                        on_jsonl_event(path);
                    }
                }
            }
            Err(e) => {
                log::warn!(
                    target: "monica_adapters::claude_watch",
                    "transcript watch error: {e}"
                );
            }
        })
        .context("failed to create the transcript watcher")?;
        Ok(Self { watcher })
    }

    pub fn watch_dir(&mut self, dir: &Path) -> Result<()> {
        self.watcher
            .watch(dir, RecursiveMode::NonRecursive)
            .with_context(|| format!("failed to watch {}", dir.display()))
    }

    pub fn unwatch_dir(&mut self, dir: &Path) {
        if let Err(e) = self.watcher.unwatch(dir) {
            log::warn!(
                target: "monica_adapters::claude_watch",
                "failed to unwatch {}: {e}",
                dir.display()
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::PathBuf;
    use std::sync::mpsc;
    use std::time::Duration;

    // FSEvents delivery is asynchronous with an OS-controlled delay.
    const FIRE_TIMEOUT: Duration = Duration::from_secs(10);
    const SILENCE_WINDOW: Duration = Duration::from_millis(750);

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "monica-watch-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // FSEvents reports canonical paths; env::temp_dir goes through /var -> /private/var.
        dir.canonicalize().unwrap()
    }

    fn watcher_into(tx: mpsc::Sender<PathBuf>) -> FsJsonlWatcher {
        FsJsonlWatcher::new(Box::new(move |path| {
            let _ = tx.send(path.to_path_buf());
        }))
        .unwrap()
    }

    fn wait_for(rx: &mpsc::Receiver<PathBuf>, path: &Path) {
        let deadline = std::time::Instant::now() + FIRE_TIMEOUT;
        loop {
            let remaining = deadline
                .checked_duration_since(std::time::Instant::now())
                .expect("timed out waiting for a watch event");
            if rx.recv_timeout(remaining).unwrap() == path {
                return;
            }
        }
    }

    #[test]
    fn fires_on_jsonl_creation_and_append() {
        let dir = temp_dir("fires");
        let (tx, rx) = mpsc::channel();
        let mut watcher = watcher_into(tx);
        watcher.watch_dir(&dir).unwrap();

        let path = dir.join("session.jsonl");
        std::fs::write(&path, "{\"type\":\"user\"}\n").unwrap();
        wait_for(&rx, &path);

        let mut file = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(b"{\"type\":\"assistant\"}\n").unwrap();
        file.sync_all().unwrap();
        wait_for(&rx, &path);
    }

    #[test]
    fn ignores_non_jsonl_files() {
        let dir = temp_dir("non-jsonl");
        let (tx, rx) = mpsc::channel();
        let mut watcher = watcher_into(tx);
        watcher.watch_dir(&dir).unwrap();

        std::fs::write(dir.join("notes.txt"), "hello").unwrap();
        let jsonl = dir.join("after.jsonl");
        std::fs::write(&jsonl, "{}\n").unwrap();

        // The jsonl event arriving without a preceding txt event shows the filter held.
        assert_eq!(rx.recv_timeout(FIRE_TIMEOUT).unwrap(), jsonl);
    }

    #[test]
    fn unwatched_dir_stops_firing() {
        let dir = temp_dir("unwatch");
        let (tx, rx) = mpsc::channel();
        let mut watcher = watcher_into(tx);
        watcher.watch_dir(&dir).unwrap();

        let path = dir.join("session.jsonl");
        std::fs::write(&path, "{}\n").unwrap();
        wait_for(&rx, &path);

        watcher.unwatch_dir(&dir);
        // Drain events already in flight from before the unwatch.
        while rx.recv_timeout(SILENCE_WINDOW).is_ok() {}

        std::fs::write(dir.join("later.jsonl"), "{}\n").unwrap();
        assert!(rx.recv_timeout(SILENCE_WINDOW).is_err());
    }
}
