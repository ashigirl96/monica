//! Concrete adapters implementing the `monica-application` ports: the GitHub API and device-flow
//! auth, the git CLI, the filesystem run-output/workspace stores, the process setup
//! runner, the keychain `secrets` primitive, and the per-agent hook decoders. Each adapter depends
//! only on the application ports and `monica-paths` — never on the SQLite store or the runtime.

pub mod agents;
pub mod filesystem;
pub mod git;
pub mod github;
pub mod process;
pub mod secrets;

#[cfg(test)]
mod test_support;
