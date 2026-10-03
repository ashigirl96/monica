use std::fs;
use std::path::{Path, PathBuf};

use crate::sibling;

/// `tania` を PATH に載せる（ADR-0006）。
pub fn link(home: &Path) {
    let Some(cli) = cli_binary() else {
        eprintln!("[shell] TANIA_BIN is not set; leaving $TANIA_HOME/bin/tania as it is");
        return;
    };
    place(&home.join("bin/tania"), &cli);
    // dev の desktop が張ると、release の CLI を dev のもので上書きしてしまう。
    if !cfg!(debug_assertions) {
        if let Some(user_home) = std::env::var_os("HOME") {
            place(&PathBuf::from(user_home).join(".local/bin/tania"), &cli);
        }
    }
}

fn cli_binary() -> Option<PathBuf> {
    std::env::var_os("TANIA_BIN")
        .map(PathBuf::from)
        .or_else(|| (!cfg!(debug_assertions)).then(|| sibling("tania")))
}

fn place(link: &Path, target: &Path) {
    if fs::read_link(link).is_ok_and(|current| current == target) {
        return;
    }
    let staged = link.with_extension("tmp");
    let result = fs::create_dir_all(link.parent().expect("link has a parent"))
        .and_then(|()| match fs::remove_file(&staged) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error),
            _ => Ok(()),
        })
        .and_then(|()| std::os::unix::fs::symlink(target, &staged))
        .and_then(|()| fs::rename(&staged, link));
    if let Err(error) = result {
        eprintln!("[shell] could not link {} to {}: {error}", link.display(), target.display());
    }
}
