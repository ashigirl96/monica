use std::path::Path;

use anyhow::Result;

pub trait ShellScaffolding {
    /// Prepare the agent scaffolding (wrappers, zdotdir, inline hooks config) every Monica-spawned
    /// shell gets, task or not, so any supported agent launched in any tab reports back through
    /// hooks. `cwd` is the directory the shell opens in: repo-local hook configs left behind by
    /// older versions are stripped there so inline hooks don't fire twice. Returns the env vars
    /// the shell must be spawned with.
    fn prepare_base_shell_env(&self, cwd: &Path) -> Result<Vec<(String, String)>>;
}
