//! Deferred worktree deletion: a worktree is renamed into a `.monica-trash/` directory beside it
//! (constant time — same parent, so same volume by construction) and the actual `rm -rf` runs in a
//! detached process. A deletion that never finished — a reaper cut off by a reboot, a `/bin/rm`
//! that failed to spawn — waits there until the next [`reap`], which the application runs over
//! every worktree path it has ever recorded, so no root is ever forgotten and no periodic job is
//! needed.
//!
//! A worktree root is only ever the *parent* of a recorded path, so it can be a directory Monica
//! does not own — a legacy run stamped with the main checkout puts the repo's parent in that set.
//! A reaper therefore removes nothing until it finds [`OWNER_MARKER`], which [`bury`] writes only
//! into a trash directory it created itself: ownership is proven, never inferred from a name and
//! never claimed after the fact. Inside a directory Monica created, everything is Monica's, and the
//! only writer is [`bury`], which callers reach after the live-worktree guards. That keeps "delete
//! a live worktree" unreachable from this module.

use std::collections::BTreeSet;
use std::ffi::OsStr;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Context, Result};

const TRASH_DIR: &str = ".monica-trash";
/// Written by [`bury`] when it creates a trash directory; its absence means the directory is not
/// Monica's to empty.
const OWNER_MARKER: &str = ".created-by-monica";

pub(crate) fn trash_dir(worktree_root: &Path) -> PathBuf {
    worktree_root.join(TRASH_DIR)
}

/// Move `worktree` into its root's `.monica-trash/`. Falls back to a synchronous recursive delete
/// only if the rename is refused as cross-device, which a sibling directory should never be — this
/// keeps cleanup correct on an exotic mount layout.
pub(crate) fn bury(repo: &Path, worktree: &Path) -> Result<()> {
    let repo_name = repo.file_name().and_then(|n| n.to_str()).unwrap_or("repo");
    let name = worktree
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| anyhow!("worktree {} has no usable name", worktree.display()))?;
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    bury_as(
        worktree,
        &format!("{repo_name}.{name}.{millis}.{}", std::process::id()),
    )
}

fn bury_as(worktree: &Path, stamp: &str) -> Result<()> {
    let root = worktree
        .parent()
        .ok_or_else(|| anyhow!("worktree {} has no parent directory", worktree.display()))?;
    let trash = ensure_trash_dir(root)?;

    // rename(2) silently replaces an empty directory, so an existing entry — even a hollow one
    // left by a half-finished reaper — must be skipped before the syscall, not detected after.
    let mut dest = trash.join(stamp);
    let mut attempt = 0u32;
    while dest.symlink_metadata().is_ok() {
        attempt += 1;
        dest = trash.join(format!("{stamp}.{attempt}"));
    }
    match fs::rename(worktree, &dest) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::CrossesDevices => {
            log::warn!(
                target: "monica_adapters::worktree_trash",
                "{} is on another volume than {}; deleting synchronously",
                worktree.display(),
                trash.display()
            );
            fs::remove_dir_all(worktree)
                .with_context(|| format!("failed to delete {}", worktree.display()))
        }
        Err(e) => Err(e).with_context(|| {
            format!("failed to move {} to {}", worktree.display(), dest.display())
        }),
    }
}

/// The root's trash directory. Only a directory this call creates is stamped as Monica's: adopting
/// one that was already there would hand its unrelated contents to the next reap.
fn ensure_trash_dir(worktree_root: &Path) -> Result<PathBuf> {
    let trash = trash_dir(worktree_root);
    let marker = trash.join(OWNER_MARKER);
    match fs::create_dir(&trash) {
        Ok(()) => {
            // Without the marker nothing buried here is ever reclaimable, so a burial that cannot
            // write it must fail rather than leak the tree it is about to move.
            fs::write(&marker, b"")
                .with_context(|| format!("failed to write {}", marker.display()))?;
        }
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
            if !marker.is_file() {
                return Err(anyhow!(
                    "refusing to use {}: it already exists and was not created by Monica",
                    trash.display()
                ));
            }
        }
        Err(e) => {
            return Err(e).with_context(|| format!("failed to create {}", trash.display()));
        }
    }
    Ok(trash)
}

/// Everything waiting in a root's `.monica-trash/`, in no particular order — nothing at all unless
/// [`bury`] created that directory.
pub(crate) fn pending(worktree_root: &Path) -> Vec<PathBuf> {
    let trash = trash_dir(worktree_root);
    if !trash.join(OWNER_MARKER).is_file() {
        return Vec::new();
    }
    let Ok(entries) = fs::read_dir(&trash) else {
        return Vec::new();
    };
    entries
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name() != OsStr::new(OWNER_MARKER))
        .map(|e| e.path())
        .collect()
}

/// Everything waiting in the `.monica-trash/` beside any of `worktrees`, each root visited once. A
/// relative recorded path would resolve its trash directory against whatever cwd the CLI happens to
/// run in, so only absolute roots are visited.
fn pending_beside(worktrees: &[PathBuf]) -> Vec<PathBuf> {
    worktrees
        .iter()
        .filter_map(|w| w.parent())
        .filter(|root| root.is_absolute())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .flat_map(pending)
        .collect()
}

/// Hand everything waiting beside any of `worktrees` to a detached `rm -rf` in one go. Failures
/// are logged, not returned: the worktrees are already gone from git's view and the entries stay
/// for the next reap.
pub(crate) fn reap(worktrees: &[PathBuf]) {
    let paths = pending_beside(worktrees);
    if paths.is_empty() {
        return;
    }
    match spawn_detached_rm(paths) {
        Ok(count) => log::info!(
            target: "monica_adapters::worktree_trash",
            "reaping {count} trashed worktree entries"
        ),
        Err(e) => log::error!(
            target: "monica_adapters::worktree_trash",
            "failed to start worktree reaper: {e:#}"
        ),
    }
}

/// `rm -rf` in its own process group with no inherited stdio, so it outlives a CLI invocation and
/// is not taken down with the desktop app. A small thread collects the exit status so the desktop
/// never accumulates zombies.
fn spawn_detached_rm(paths: Vec<PathBuf>) -> Result<usize> {
    let mut command = Command::new("/bin/rm");
    command
        .arg("-rf")
        .args(&paths)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().context("failed to spawn /bin/rm")?;
    let count = paths.len();
    let watcher = std::thread::Builder::new()
        .name("monica-worktree-reaper".to_string())
        .spawn(move || {
            let summary = || {
                paths
                    .iter()
                    .map(|p| p.display().to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            };
            match child.wait() {
                Ok(status) if status.success() => {}
                Ok(status) => log::warn!(
                    target: "monica_adapters::worktree_trash",
                    "rm -rf exited with {status} for {}",
                    summary()
                ),
                Err(e) => log::warn!(
                    target: "monica_adapters::worktree_trash",
                    "failed to wait for rm -rf ({}): {e}",
                    summary()
                ),
            }
        });
    // The rm is already running and detached; losing its watcher only costs a zombie entry, so it
    // must not be reported as a failed reap.
    if let Err(e) = watcher {
        log::warn!(
            target: "monica_adapters::worktree_trash",
            "reaper wait thread not started ({e}); rm -rf runs unwatched"
        );
    }
    Ok(count)
}

/// A trash directory stamped as Monica's without going through [`bury`], for tests that need
/// entries already waiting in one.
#[cfg(test)]
pub(crate) fn seed_trash_dir(worktree_root: &Path) -> PathBuf {
    fs::create_dir_all(worktree_root).unwrap();
    ensure_trash_dir(worktree_root).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{wait_for_removal, Tmp};

    #[test]
    fn bury_moves_into_a_sibling_trash_dir_named_after_repo_and_worktree() {
        let root = Tmp::new("trash-move");
        let repo = root.path().join("monica");
        let worktrees = root.path().join("worktrees");
        let worktree = worktrees.join("issue-1");
        fs::create_dir_all(worktree.join("target/deep")).unwrap();
        fs::write(worktree.join("target/deep/a.o"), b"x").unwrap();

        bury(&repo, &worktree).unwrap();

        assert!(!worktree.exists());
        let trashed = pending(&worktrees);
        assert_eq!(trashed.len(), 1);
        let dest = &trashed[0];
        assert_eq!(dest.parent().unwrap(), trash_dir(&worktrees));
        assert!(dest
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("monica.issue-1."));
        assert!(dest.join("target/deep/a.o").exists());
    }

    #[test]
    fn bury_disambiguates_colliding_stamps() {
        let root = Tmp::new("trash-collide");
        let trash = seed_trash_dir(root.path());
        fs::create_dir_all(trash.join("monica.issue-1.7.42")).unwrap();
        fs::create_dir_all(trash.join("monica.issue-1.7.42.1")).unwrap();
        let worktree = root.path().join("issue-1");
        fs::create_dir_all(&worktree).unwrap();
        fs::write(worktree.join("marker"), b"x").unwrap();

        bury_as(&worktree, "monica.issue-1.7.42").unwrap();

        assert!(!worktree.exists());
        assert!(trash.join("monica.issue-1.7.42.2").join("marker").exists());
        assert_eq!(pending(root.path()).len(), 3);
    }

    #[test]
    fn pending_beside_is_empty_without_trash_entries() {
        let root = Tmp::new("trash-none");

        let paths = pending_beside(&[
            root.path().join("issue-1"),
            root.path().join("missing").join("issue-2"),
        ]);

        assert!(paths.is_empty());
    }

    #[test]
    fn pending_beside_collects_every_entry_across_roots_once() {
        let root = Tmp::new("trash-reap");
        let a = root.path().join("a");
        let b = root.path().join("b");
        fs::create_dir_all(seed_trash_dir(&a).join("x.old.1.1")).unwrap();
        fs::create_dir_all(seed_trash_dir(&b).join("y.old.2.1")).unwrap();
        fs::create_dir_all(seed_trash_dir(&b).join("y.old.3.1")).unwrap();

        let mut paths = pending_beside(&[a.join("issue-1"), b.join("issue-2"), b.join("issue-3")]);
        paths.sort();

        assert_eq!(
            paths,
            vec![
                trash_dir(&a).join("x.old.1.1"),
                trash_dir(&b).join("y.old.2.1"),
                trash_dir(&b).join("y.old.3.1"),
            ]
        );
    }

    #[test]
    fn pending_ignores_a_trash_dir_monica_did_not_create() {
        let root = Tmp::new("trash-foreign");
        let trash = trash_dir(root.path());
        fs::create_dir_all(trash.join("notes")).unwrap();
        fs::create_dir_all(trash.join("project.backup.2024.01")).unwrap();

        assert!(pending(root.path()).is_empty());
    }

    #[test]
    fn bury_refuses_to_adopt_a_trash_dir_monica_did_not_create() {
        let root = Tmp::new("trash-adopt");
        let trash = trash_dir(root.path());
        fs::create_dir_all(trash.join("someone-elses-data")).unwrap();
        let worktree = root.path().join("issue-1");
        fs::create_dir_all(&worktree).unwrap();

        let err = bury_as(&worktree, "monica.issue-1.7.42").unwrap_err();

        assert!(format!("{err:#}").contains("was not created by Monica"));
        assert!(worktree.exists());
        assert!(!trash.join(OWNER_MARKER).exists());
        assert!(pending(root.path()).is_empty());
    }

    #[test]
    fn pending_skips_the_ownership_marker_itself() {
        let root = Tmp::new("trash-marker");
        let trash = seed_trash_dir(root.path());
        fs::create_dir_all(trash.join("repo.issue-1.7.42")).unwrap();

        assert_eq!(pending(root.path()), vec![trash.join("repo.issue-1.7.42")]);
    }

    #[test]
    fn pending_beside_ignores_relative_worktree_paths() {
        assert!(pending_beside(&[PathBuf::from("issue-1")]).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn detached_rm_removes_the_tree_after_returning() {
        let root = Tmp::new("trash-detached-rm");
        let victim = root.path().join("victim");
        fs::create_dir_all(victim.join("nested/deeper")).unwrap();
        fs::write(victim.join("nested/deeper/file"), b"bye").unwrap();

        assert_eq!(spawn_detached_rm(vec![victim.clone()]).unwrap(), 1);

        wait_for_removal(&victim);
    }
}
