//! debug build（dev）と release で違う、Shell が扱う場所。

use std::path::{Path, PathBuf};
use std::process::Command;

pub fn tania_home() -> PathBuf {
    std::env::var_os("TANIA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            user_home().join(if cfg!(debug_assertions) {
                ".tania-dev"
            } else {
                ".tania"
            })
        })
}

/// dev は source を `bun --watch` で動かし、package の編集で同じ pid のまま再起動させる。
pub fn backend() -> Command {
    if cfg!(debug_assertions) {
        let mut command = Command::new("bun");
        command
            .arg("--watch")
            .arg(repo().join("apps/backend/src/main.ts"));
        command
    } else {
        Command::new(bundled_binary("tania-backend"))
    }
}

pub fn ptyd() -> PathBuf {
    if cfg!(debug_assertions) {
        std::env::var_os("TANIA_PTYD_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|| repo().join("target/debug/tania-ptyd"))
    } else {
        bundled_binary("tania-ptyd")
    }
}

/// dev の port は `scripts/desktop.ts` が env に入れ、Backend は Shell の env からそのまま継ぐ。
pub fn notes_port() -> Option<&'static str> {
    (!cfg!(debug_assertions)).then_some("19380")
}

pub fn cli() -> Option<PathBuf> {
    std::env::var_os("TANIA_BIN")
        .map(PathBuf::from)
        .or_else(|| (!cfg!(debug_assertions)).then(|| bundled_binary("tania")))
}

/// dev の desktop が張ると release の CLI を dev のもので上書きするので、release だけが返す。
pub fn user_cli_link() -> Option<PathBuf> {
    (!cfg!(debug_assertions)).then(|| user_home().join(".local/bin/tania"))
}

fn bundled_binary(name: &str) -> PathBuf {
    let exe = std::env::current_exe().expect("current_exe is readable");
    exe.parent().expect("exe has a directory").join(name)
}

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn user_home() -> PathBuf {
    PathBuf::from(std::env::var_os("HOME").expect("HOME is set"))
}
