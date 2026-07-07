//! Watches Claude Code's transcript directories while someone is subscribed to the
//! session, and pokes the drain worker the moment a `.jsonl` under one changes. This is
//! the entire data-path trigger: the watcher never reads a transcript and never emits an
//! event — reading, cursor movement, and emission all stay on the drain thread.
//!
//! Watches are directory-scoped and refcounted twice: per session (several subscribers
//! to one session share a retain) and per directory (several sessions in one cwd share a
//! watch). The directory rather than the file is watched because Claude creates the
//! `.jsonl` lazily on the first user message.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use monica_application::claude_project_dir;

/// The filesystem-notification seam, so the manager is testable with a fake backend.
pub trait WatchBackend: Send {
    fn watch_dir(&mut self, dir: &Path) -> anyhow::Result<()>;
    fn unwatch_dir(&mut self, dir: &Path);
}

impl WatchBackend for monica_adapters::claude::FsJsonlWatcher {
    fn watch_dir(&mut self, dir: &Path) -> anyhow::Result<()> {
        self.watch_dir(dir)
    }

    fn unwatch_dir(&mut self, dir: &Path) {
        self.unwatch_dir(dir);
    }
}

/// dir → sessions watching it; shared with the backend's event callback, which resolves
/// a changed path back to the sessions to wake.
type DirIndex = Mutex<HashMap<PathBuf, HashSet<String>>>;

struct WatchState {
    backend: Box<dyn WatchBackend>,
    /// session → (its watch dir, how many retains hold it).
    session_refs: HashMap<String, (PathBuf, usize)>,
    /// dir → how many sessions hold a watch on it.
    dir_refs: HashMap<PathBuf, usize>,
}

pub struct TranscriptWatchHandle {
    home: PathBuf,
    state: Arc<Mutex<WatchState>>,
    index: Arc<DirIndex>,
}

impl Clone for TranscriptWatchHandle {
    fn clone(&self) -> Self {
        Self {
            home: self.home.clone(),
            state: Arc::clone(&self.state),
            index: Arc::clone(&self.index),
        }
    }
}

/// A live retain, released on drop — the same RAII shape as the broadcaster's
/// `Subscription`, so every subscription exit path drops its watch with it.
pub struct WatchRetainGuard {
    handle: TranscriptWatchHandle,
    claude_session_id: String,
}

impl Drop for WatchRetainGuard {
    fn drop(&mut self) {
        self.handle.release(&self.claude_session_id);
    }
}

/// Start watching with the FSEvents backend. `wake` is called with a session id from the
/// watcher's thread whenever that session's transcript directory changes.
pub fn start_transcript_watch(
    home: PathBuf,
    wake: impl Fn(&str) + Send + Sync + 'static,
) -> anyhow::Result<TranscriptWatchHandle> {
    transcript_watch_with_backend(home, wake, |on_jsonl_event| {
        Ok(Box::new(monica_adapters::claude::FsJsonlWatcher::new(on_jsonl_event)?))
    })
}

/// Backend-injectable variant for tests. The factory receives the callback the backend
/// must fire per changed `.jsonl` path.
pub fn transcript_watch_with_backend<F>(
    home: PathBuf,
    wake: impl Fn(&str) + Send + Sync + 'static,
    make_backend: F,
) -> anyhow::Result<TranscriptWatchHandle>
where
    F: FnOnce(Box<dyn Fn(&Path) + Send>) -> anyhow::Result<Box<dyn WatchBackend>>,
{
    let index: Arc<DirIndex> = Arc::default();
    let callback_index = Arc::clone(&index);
    let backend = make_backend(Box::new(move |jsonl_path| {
        let Some(dir) = jsonl_path.parent() else {
            return;
        };
        let sessions = callback_index.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(watching) = sessions.get(dir) else {
            return;
        };
        for claude_session_id in watching {
            wake(claude_session_id);
        }
    }))?;
    Ok(TranscriptWatchHandle {
        home,
        state: Arc::new(Mutex::new(WatchState {
            backend,
            session_refs: HashMap::new(),
            dir_refs: HashMap::new(),
        })),
        index,
    })
}

impl TranscriptWatchHandle {
    /// Keep the session's transcript directory watched until the guard drops. A watch
    /// that cannot be established is logged and skipped — the drain's turn-completed
    /// read still delivers, just without mid-turn streaming.
    pub fn retain(&self, claude_session_id: &str, cwd: &str) -> WatchRetainGuard {
        let dir = self.resolve_dir(cwd);
        let mut state = self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let (_, session_count) = state
            .session_refs
            .entry(claude_session_id.to_string())
            .or_insert_with(|| (dir.clone(), 0));
        *session_count += 1;
        if *session_count == 1 {
            self.index
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .entry(dir.clone())
                .or_default()
                .insert(claude_session_id.to_string());
            let dir_count = state.dir_refs.entry(dir.clone()).or_default();
            *dir_count += 1;
            if *dir_count == 1 {
                if let Err(e) = state.backend.watch_dir(&dir) {
                    log::warn!(
                        target: "monica_runtime::transcript_watch",
                        "failed to watch {} for {claude_session_id}: {e:#}",
                        dir.display()
                    );
                }
            }
        }
        WatchRetainGuard { handle: self.clone(), claude_session_id: claude_session_id.to_string() }
    }

    /// The watch directory for a cwd, created eagerly (Claude makes it lazily, and a
    /// watch needs it to exist) and canonicalized (FSEvents reports canonical paths, and
    /// the callback's index lookup must match them).
    fn resolve_dir(&self, cwd: &str) -> PathBuf {
        let dir = claude_project_dir(&self.home, cwd);
        if let Err(e) = std::fs::create_dir_all(&dir) {
            log::warn!(
                target: "monica_runtime::transcript_watch",
                "failed to create {}: {e}",
                dir.display()
            );
        }
        dir.canonicalize().unwrap_or(dir)
    }

    fn release(&self, claude_session_id: &str) {
        let mut state = self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some((dir, session_count)) = state.session_refs.get_mut(claude_session_id) else {
            return;
        };
        *session_count -= 1;
        if *session_count > 0 {
            return;
        }
        let dir = dir.clone();
        state.session_refs.remove(claude_session_id);
        {
            let mut index = self.index.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(watching) = index.get_mut(&dir) {
                watching.remove(claude_session_id);
                if watching.is_empty() {
                    index.remove(&dir);
                }
            }
        }
        let Some(dir_count) = state.dir_refs.get_mut(&dir) else {
            return;
        };
        *dir_count -= 1;
        if *dir_count == 0 {
            state.dir_refs.remove(&dir);
            state.backend.unwatch_dir(&dir);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[derive(Default, Clone)]
    struct FakeBackend {
        watched: Arc<Mutex<Vec<PathBuf>>>,
        unwatched: Arc<Mutex<Vec<PathBuf>>>,
    }

    impl WatchBackend for FakeBackend {
        fn watch_dir(&mut self, dir: &Path) -> anyhow::Result<()> {
            self.watched.lock().unwrap().push(dir.to_path_buf());
            Ok(())
        }

        fn unwatch_dir(&mut self, dir: &Path) {
            self.unwatched.lock().unwrap().push(dir.to_path_buf());
        }
    }

    struct Fixture {
        handle: TranscriptWatchHandle,
        backend: FakeBackend,
        fire: Box<dyn Fn(&Path) + Send>,
        wakes: mpsc::Receiver<String>,
    }

    fn fixture() -> Fixture {
        let home = std::env::temp_dir().join(format!(
            "monica-watchtest-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let (tx, wakes) = mpsc::channel();
        let backend = FakeBackend::default();
        let backend_clone = backend.clone();
        type CapturedCallback = Mutex<Option<Box<dyn Fn(&Path) + Send>>>;
        let captured: Arc<CapturedCallback> = Arc::default();
        let captured_clone = Arc::clone(&captured);
        let handle = transcript_watch_with_backend(
            home,
            move |id| {
                let _ = tx.send(id.to_string());
            },
            move |on_event| {
                *captured_clone.lock().unwrap() = Some(on_event);
                Ok(Box::new(backend_clone))
            },
        )
        .unwrap();
        let on_event = captured.lock().unwrap().take().unwrap();
        Fixture { handle, backend, fire: on_event, wakes }
    }

    fn watch_dir_of(fixture: &Fixture, cwd: &str) -> PathBuf {
        fixture.backend.watched.lock().unwrap().last().cloned().unwrap_or_else(|| {
            claude_project_dir(&fixture.handle.home, cwd)
        })
    }

    #[test]
    fn retain_watches_and_the_last_release_unwatches() {
        let f = fixture();

        let guard = f.handle.retain("cs-1", "/w/a");
        assert_eq!(f.backend.watched.lock().unwrap().len(), 1);
        let dir = watch_dir_of(&f, "/w/a");
        assert!(dir.exists(), "the watch dir must be created eagerly");

        drop(guard);
        assert_eq!(f.backend.unwatched.lock().unwrap().as_slice(), &[dir]);
    }

    #[test]
    fn two_retains_of_one_session_share_the_watch() {
        let f = fixture();

        let a = f.handle.retain("cs-1", "/w/a");
        let b = f.handle.retain("cs-1", "/w/a");
        assert_eq!(f.backend.watched.lock().unwrap().len(), 1);

        drop(a);
        assert!(f.backend.unwatched.lock().unwrap().is_empty());
        drop(b);
        assert_eq!(f.backend.unwatched.lock().unwrap().len(), 1);
    }

    #[test]
    fn two_sessions_in_one_cwd_share_the_directory_watch() {
        let f = fixture();

        let a = f.handle.retain("cs-1", "/w/a");
        let b = f.handle.retain("cs-2", "/w/a");
        assert_eq!(f.backend.watched.lock().unwrap().len(), 1, "one dir, one watch");

        drop(a);
        assert!(f.backend.unwatched.lock().unwrap().is_empty());
        drop(b);
        assert_eq!(f.backend.unwatched.lock().unwrap().len(), 1);
    }

    #[test]
    fn a_jsonl_event_wakes_every_session_watching_its_directory() {
        let f = fixture();
        let _a = f.handle.retain("cs-1", "/w/a");
        let _b = f.handle.retain("cs-2", "/w/a");
        let dir = watch_dir_of(&f, "/w/a");

        (f.fire)(&dir.join("whatever.jsonl"));

        let mut woken: Vec<String> = f.wakes.try_iter().collect();
        woken.sort();
        assert_eq!(woken, vec!["cs-1".to_string(), "cs-2".to_string()]);
    }

    #[test]
    fn an_event_in_an_unwatched_directory_wakes_no_one() {
        let f = fixture();
        let _a = f.handle.retain("cs-1", "/w/a");

        (f.fire)(Path::new("/somewhere/else/other.jsonl"));

        assert!(f.wakes.try_iter().next().is_none());
    }

    #[test]
    fn a_released_session_no_longer_wakes() {
        let f = fixture();
        let guard = f.handle.retain("cs-1", "/w/a");
        let dir = watch_dir_of(&f, "/w/a");
        drop(guard);

        (f.fire)(&dir.join("s.jsonl"));

        assert!(f.wakes.try_iter().next().is_none());
    }
}
