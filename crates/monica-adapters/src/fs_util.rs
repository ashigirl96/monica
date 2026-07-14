use std::fs;
use std::path::Path;

/// Compare two paths for identity through symlinks, macOS firmlinks (`/home` → `/private/...`),
/// and trailing-slash differences. Falls back to a raw comparison when either path cannot be
/// canonicalized (e.g. it does not exist yet).
pub(crate) fn same_path(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::os::unix::fs as unix_fs;

    use super::*;
    use crate::test_support::Tmp;

    #[test]
    fn equates_a_symlink_with_its_target() {
        let tmp = Tmp::new("same-path-symlink");
        let target = tmp.path().join("real");
        fs::create_dir(&target).unwrap();
        let link = tmp.path().join("link");
        unix_fs::symlink(&target, &link).unwrap();

        assert!(same_path(&target, &link));
    }

    #[test]
    fn ignores_trailing_slash_on_existing_dir() {
        let tmp = Tmp::new("same-path-trailing");
        let dir = tmp.path().join("dir");
        fs::create_dir(&dir).unwrap();

        assert!(same_path(&dir, &dir.join("")));
    }

    #[test]
    fn falls_back_to_raw_comparison_for_missing_paths() {
        let missing = Path::new("/monica/does/not/exist");
        assert!(same_path(missing, missing));
        assert!(!same_path(missing, Path::new("/monica/other/missing")));
    }
}
