//! Terminal daemon: PTY 駆動・session table・transcript。portable-pty はこの crate に閉じる。

mod manager;
mod session;
mod transcript;
mod types;

pub mod daemon;
