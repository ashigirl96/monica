//! Monica core: domain logic shared by the CLI (`monica-cli`) and the Tauri app (`monica-app`).
//! Session manifest, git/gh adapters, status model. See `docs/workflow-contract.md`.

mod cmd;
pub mod manifest;
pub mod start;

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
