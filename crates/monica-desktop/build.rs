use std::process::Command;

fn main() {
    emit_git_sha();
    tauri_build::build()
}

/// Bakes the commit into the binary for the startup banner, so a log can be traced back to the
/// exact build that wrote it. A source tree with no git available still has to build, so every
/// failure resolves to `unknown` rather than stopping the build.
fn emit_git_sha() {
    // The env override lets a CI that builds from a shallow clone or a source archive supply the
    // commit it already knows, without needing git in the build image.
    println!("cargo:rerun-if-env-changed=MONICA_GIT_SHA");
    let sha = std::env::var("MONICA_GIT_SHA")
        .ok()
        .or_else(|| git(&["rev-parse", "--short", "HEAD"]))
        .unwrap_or_else(|| "unknown".to_string());
    println!("cargo:rustc-env=MONICA_GIT_SHA={sha}");

    // HEAD alone is not enough: committing on a branch moves `refs/heads/<branch>` (or packs it)
    // while HEAD keeps pointing at the same ref, which would leave a stale sha baked in until
    // something else forced a rebuild. `--git-path` resolves each one through the worktree's
    // gitdir, where `.git` is a file rather than a directory.
    let branch = git(&["symbolic-ref", "--quiet", "HEAD"]);
    let watched: Vec<&str> =
        ["HEAD", "packed-refs"].into_iter().chain(branch.as_deref()).collect();
    let mut args = vec!["rev-parse"];
    for path in &watched {
        args.extend(["--git-path", path]);
    }
    if let Some(resolved) = git(&args) {
        for line in resolved.lines() {
            println!("cargo:rerun-if-changed={line}");
        }
    }
}

fn git(args: &[&str]) -> Option<String> {
    let output = Command::new("git").args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8(output.stdout).ok()?.trim().to_string();
    (!value.is_empty()).then_some(value)
}
