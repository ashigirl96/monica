//! Terminal daemon: PTY 駆動・session table・transcript。portable-pty はこの crate に閉じる。

mod manager;
mod session;
mod session_processes;
mod terminal_modes;
mod transcript;
mod types;

pub mod daemon;
