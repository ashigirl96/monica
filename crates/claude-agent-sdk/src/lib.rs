//! Claude Agent SDK for Rust.
//!
//! `claude` CLI を `-p` なしの stream-json I/O で spawn し、公式 TypeScript Agent SDK と
//! 同じ interface で操作するための crate。subscription 課金枠を維持するため、
//! SDK entrypoint 環境変数は設定せず除去する（詳細は TODO.md と issue #342 / #341 参照）。

pub mod callbacks;
pub mod error;
pub mod transport;
pub mod types;

pub use error::{ClaudeError, Result};
