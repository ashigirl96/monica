//! Every log target this crate writes under, together so `MONICA_LOG=` has one list to answer to.

/// The startup banner.
pub(crate) const STARTUP: &str = "monica_runtime::startup";
/// The two-second notification drain and its suppression.
pub(crate) const NOTIFICATION_DRAIN: &str = "monica_runtime::notification_drain";
/// The GitHub sync worker, as distinct from the sync itself (`monica_application::github_sync`).
pub(crate) const GITHUB_SYNC: &str = "monica_runtime::github_sync";
/// Sweeping note assets nothing references any more.
pub(crate) const ASSET_GC: &str = "monica_runtime::asset_gc";

#[cfg(test)]
mod tests {
    use super::*;

    const ALL_TARGETS: &[&str] = &[STARTUP, NOTIFICATION_DRAIN, GITHUB_SYNC, ASSET_GC];

    /// fern matches a target by `::` segment, so a target that does not name this crate is
    /// unreachable from `MONICA_LOG=<crate>=debug`. Anchoring on the package name (not
    /// `CARGO_CRATE_NAME`, which a `[lib] name` override changes) makes a crate rename fail here.
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
