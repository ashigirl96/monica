//! Every log target this crate writes under.
//!
//! They live together because a target is the only name a user types at `MONICA_LOG=` and the
//! compiler checks none of it: these were still spelled `monica_app::*` long after the crate was
//! renamed to `monica-desktop`, which left `MONICA_LOG=monica_desktop=debug` reaching four lines
//! out of thirty-four. The test below is what turns the next rename into a failure here instead.

/// One line per Tauri command call.
pub(crate) const COMMANDS: &str = "monica_desktop::commands";
/// The connection to `monica-ptyd` and the terminal events it pushes.
pub(crate) const PTYD: &str = "monica_desktop::ptyd";
/// The `monica-browser-bridge` child process.
pub(crate) const BRIDGE: &str = "monica_desktop::bridge";
/// Banner, log filter, and everything else that happens once at launch.
pub(crate) const STARTUP: &str = "monica_desktop::startup";
/// The embedded web server.
pub(crate) const WEB: &str = "monica_desktop::web";
/// Reaping trashed worktrees.
pub(crate) const WORKTREE_TRASH: &str = "monica_desktop::worktree_trash";
/// Opening and closing windows.
pub(crate) const WINDOW: &str = "monica_desktop::window";
/// The background half of Prepare.
pub(crate) const PREPARE_TASK: &str = "monica_desktop::prepare_task";
/// Application events on their way to the webview.
pub(crate) const EVENTS: &str = "monica_desktop::events";
/// The settings window.
pub(crate) const SETTINGS: &str = "monica_desktop::settings";

#[cfg(test)]
mod tests {
    use super::*;

    const ALL_TARGETS: &[&str] = &[
        COMMANDS,
        PTYD,
        BRIDGE,
        STARTUP,
        WEB,
        WORKTREE_TRASH,
        WINDOW,
        PREPARE_TASK,
        EVENTS,
        SETTINGS,
    ];

    /// fern matches a target by `::` segment, so a target that does not name this crate is
    /// unreachable from `MONICA_LOG=<crate>=debug`. The anchor is the package name and not
    /// `CARGO_CRATE_NAME`, which the `[lib] name = "monica_desktop_lib"` override would answer.
    #[test]
    fn every_target_is_reachable_from_this_crate_name() {
        let crate_name = env!("CARGO_PKG_NAME").replace('-', "_");
        for target in ALL_TARGETS {
            let rest = target.strip_prefix(&crate_name);
            assert!(
                rest.is_some_and(|rest| rest.is_empty() || rest.starts_with("::")),
                "{target} is unreachable from MONICA_LOG={crate_name}=debug"
            );
        }
    }
}
