//! Concrete adapters implementing the `monica-application` ports: the GitHub API and
//! gh-CLI-backed auth, the git CLI, the filesystem run-output/workspace stores, the process
//! setup runner, and the per-agent hook decoders. Each adapter depends only on the
//! application ports and `monica-paths` — never on the SQLite store or the runtime.

pub mod agents;
pub mod assets;
pub mod filesystem;
pub mod git;
pub mod github;
pub mod ogp;
pub mod process;

mod fs_util;
mod http;

#[cfg(test)]
mod test_support;
