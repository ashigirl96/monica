use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};

use monica_domain::{
    AgentSessionStatus, NewTerminalSession, ProviderSessionEvent, TerminalSessionKind,
};
use monica_storage_sqlite::SqliteStore;

fn unique_temp_dir(tag: &str) -> PathBuf {
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let count = COUNTER.fetch_add(1, Ordering::Relaxed);
    let path = std::env::temp_dir().join(format!(
        "monica-cli-explain-{tag}-{}-{count}",
        std::process::id()
    ));
    std::fs::remove_dir_all(&path).ok();
    path
}

fn seeded_terminal(home: &Path, provider_session_id: Option<&str>) -> String {
    let db_dir = home.join("db");
    std::fs::create_dir_all(&db_dir).unwrap();
    let mut store = SqliteStore::open_at(db_dir.join("monica.db")).unwrap();
    let session = store
        .create_terminal_session(NewTerminalSession {
            runspace_id: None,
            tab_id: Some("tab-1".to_string()),
            kind: TerminalSessionKind::Agent,
            cwd: "/tmp".to_string(),
            shell: "/bin/zsh".to_string(),
            rows: 24,
            cols: 80,
        })
        .unwrap();
    store
        .set_terminal_session_agent_status(
            &session.id,
            Some(AgentSessionStatus::Running),
            None,
            provider_session_id,
            ProviderSessionEvent::Started,
        )
        .unwrap();
    session.id
}

#[test]
fn explain_new_prints_only_created_directory_and_uses_terminal_home() {
    let terminal_home = unique_temp_dir("terminal-home");
    let overwritten_home = unique_temp_dir("overwritten-home");
    let terminal_session_id = seeded_terminal(&terminal_home, Some("claude-session-1"));

    let output = Command::new(env!("CARGO_BIN_EXE_monica"))
        .args(["explain", "new", "How sessions work"])
        .env("MONICA_HOME", &overwritten_home)
        .env("MONICA_TERMINAL_HOME", &terminal_home)
        .env("MONICA_TERMINAL_SESSION_ID", &terminal_session_id)
        .output()
        .unwrap();

    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    assert!(output.stderr.is_empty());
    let stdout = String::from_utf8(output.stdout).unwrap();
    let artifact_dir = terminal_home.join("explanation/exp-1");
    assert_eq!(stdout, format!("{}\n", artifact_dir.display()));
    assert!(artifact_dir.is_dir());
    assert!(!overwritten_home.join("db/monica.db").exists());

    let store = SqliteStore::open_at(terminal_home.join("db/monica.db")).unwrap();
    let explanation = store.get_explanation("exp-1").unwrap().unwrap();
    assert_eq!(explanation.title, "How sessions work");
    assert_eq!(explanation.provider_session_id, "claude-session-1");
    assert_eq!(explanation.terminal_session_id, terminal_session_id);

    std::fs::remove_dir_all(terminal_home).ok();
    std::fs::remove_dir_all(overwritten_home).ok();
}

#[test]
fn explain_new_fails_outside_a_monica_terminal() {
    let home = unique_temp_dir("no-terminal");
    let output = Command::new(env!("CARGO_BIN_EXE_monica"))
        .args(["explain", "new", "Topic"])
        .env("MONICA_HOME", &home)
        .env_remove("MONICA_TERMINAL_HOME")
        .env_remove("MONICA_TERMINAL_SESSION_ID")
        .output()
        .unwrap();

    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("MONICA_TERMINAL_SESSION_ID is not set")
    );
    assert!(!home.join("db/monica.db").exists());

    std::fs::remove_dir_all(home).ok();
}

#[test]
fn explain_new_fails_when_terminal_has_no_provider_session() {
    let home = unique_temp_dir("no-provider");
    let terminal_session_id = seeded_terminal(&home, None);
    let output = Command::new(env!("CARGO_BIN_EXE_monica"))
        .args(["explain", "new", "Topic"])
        .env("MONICA_HOME", &home)
        .env("MONICA_TERMINAL_HOME", &home)
        .env("MONICA_TERMINAL_SESSION_ID", &terminal_session_id)
        .output()
        .unwrap();

    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("has no provider session id"));
    assert!(!home.join("explanation").exists());
    let store = SqliteStore::open_at(home.join("db/monica.db")).unwrap();
    assert!(store.list_explanations().unwrap().is_empty());

    std::fs::remove_dir_all(home).ok();
}

#[test]
fn explain_new_fails_closed_without_the_terminal_home_binding() {
    let home = unique_temp_dir("no-terminal-home");
    let terminal_session_id = seeded_terminal(&home, Some("claude-session-1"));
    let output = Command::new(env!("CARGO_BIN_EXE_monica"))
        .args(["explain", "new", "Topic"])
        .env("MONICA_HOME", &home)
        .env_remove("MONICA_TERMINAL_HOME")
        .env("MONICA_TERMINAL_SESSION_ID", &terminal_session_id)
        .output()
        .unwrap();

    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("MONICA_TERMINAL_HOME is not set"));
    assert!(!home.join("explanation").exists());

    let relative = Command::new(env!("CARGO_BIN_EXE_monica"))
        .args(["explain", "new", "Topic"])
        .env("MONICA_HOME", &home)
        .env("MONICA_TERMINAL_HOME", "relative-home")
        .env("MONICA_TERMINAL_SESSION_ID", &terminal_session_id)
        .output()
        .unwrap();
    assert!(!relative.status.success());
    assert!(String::from_utf8_lossy(&relative.stderr).contains("must be an absolute path"));

    std::fs::remove_dir_all(home).ok();
}
