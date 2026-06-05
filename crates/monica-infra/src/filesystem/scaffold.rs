use std::fs;
use std::path::Path;

use anyhow::{Context, Result};

pub fn scaffold_monica(dir: &Path) -> Result<Vec<(String, bool)>> {
    let monica_dir = dir.join(".monica");
    fs::create_dir_all(&monica_dir)
        .with_context(|| format!("failed to create {}", monica_dir.display()))?;
    Ok(vec![
        write_if_absent(&monica_dir, "setup.sh", SETUP_SH_TEMPLATE, true)?,
        write_if_absent(&monica_dir, "prompt.md", PROMPT_MD_TEMPLATE, false)?,
    ])
}

fn write_if_absent(
    dir: &Path,
    name: &str,
    contents: &str,
    executable: bool,
) -> Result<(String, bool)> {
    let path = dir.join(name);
    let rel = format!(".monica/{name}");
    if path.exists() {
        return Ok((rel, false));
    }
    fs::write(&path, contents).with_context(|| format!("failed to write {}", path.display()))?;
    if executable {
        set_executable(&path)?;
    }
    Ok((rel, true))
}

#[cfg(unix)]
fn set_executable(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = fs::metadata(path)?.permissions();
    perms.set_mode(0o755);
    fs::set_permissions(path, perms).with_context(|| format!("failed to chmod {}", path.display()))
}

#[cfg(not(unix))]
fn set_executable(_path: &Path) -> Result<()> {
    Ok(())
}

const SETUP_SH_TEMPLATE: &str = r#"#!/usr/bin/env bash
set -euo pipefail

# Monica runs this in the worktree before launching the agent. Keep it idempotent.
# Available env: MONICA_ID, MONICA_RUN_ID, MONICA_PROJECT_ID, MONICA_BRANCH, MONICA_WORKTREE
# 例:
#   corepack enable
#   pnpm install --frozen-lockfile
"#;

const PROMPT_MD_TEMPLATE: &str = r#"<!-- Monica passes this file's contents as the initial prompt to the agent. -->
/tackle
"#;
