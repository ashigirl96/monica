use std::path::{Path, PathBuf};
use std::process::Command;

// set_var はプロセスグローバルで、並列実行されるテスト同士が競合する。さらにセッション環境の
// MONICA_HOME（実データの home）を継承すると、テストが本物の DB・ファイルを触ってしまう。
// main 前（単一スレッド時）に一度だけプロセス専用の temp home へ差し替え、以降テスト内では
// set_var("MONICA_HOME") を呼ばないこと。
#[ctor::ctor]
#[allow(clippy::disallowed_methods)] // main 前の単一スレッド区間なので data race がない
fn isolate_monica_home() {
    let dir = std::env::temp_dir().join(format!("monica-test-home-{}", std::process::id()));
    std::env::set_var("MONICA_HOME", dir);
}

pub struct Tmp {
    path: PathBuf,
}

impl Tmp {
    pub fn new(tag: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "monica-adapters-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        Self { path }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

pub fn init_repo(dir: &Path) {
    run_git(dir, &["init", "-b", "main"]);
    run_git(dir, &["config", "user.email", "monica@example.com"]);
    run_git(dir, &["config", "user.name", "Monica"]);
    std::fs::write(dir.join("README.md"), "hello\n").unwrap();
    run_git(dir, &["add", "README.md"]);
    run_git(dir, &["commit", "-m", "initial"]);
}

pub fn run_git(dir: &Path, args: &[&str]) {
    let output = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {:?} failed: {}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
}
