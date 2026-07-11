use std::path::Path;

use crate::ports::TerminalSessionRepository;
use crate::prelude::{
    AgentSessionStatus, ExplanationMode, NewTerminalSession, ProviderSessionEvent,
    TerminalSessionKind,
};
use crate::ApplicationError;

use super::support::{facade, FakeRepos, RecordingSink};

fn terminal(repos: &mut FakeRepos, provider_session_id: Option<&str>) -> String {
    let session = repos
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
    repos
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
fn creates_topic_from_terminal_and_copies_provider_session() {
    let mut repos = FakeRepos::default();
    let terminal_session_id = terminal(&mut repos, Some("claude-session-1"));
    let mut monica = facade(repos, RecordingSink::default());

    let created = monica
        .explanations()
        .create_topic("  Session storage  ", &terminal_session_id, Path::new("/artifacts"))
        .unwrap();

    assert_eq!(created.title, "Session storage");
    assert_eq!(created.mode, ExplanationMode::Topic);
    assert_eq!(created.provider_session_id, "claude-session-1");
    assert_eq!(created.terminal_session_id, terminal_session_id);
    assert_eq!(created.artifact_path, "/artifacts/exp-1");
    assert_eq!(
        monica.explanations().get_explanation("exp-1").unwrap(),
        Some(created.clone())
    );
    assert_eq!(monica.explanations().list_explanations().unwrap(), vec![created]);
}

#[test]
fn rejects_missing_terminal_session() {
    let mut monica = facade(FakeRepos::default(), RecordingSink::default());

    let error = monica
        .explanations()
        .create_topic("Topic", "ts-404", Path::new("/artifacts"))
        .unwrap_err();

    assert!(matches!(error, ApplicationError::NotFound(_)));
}

#[test]
fn rejects_terminal_without_provider_session() {
    for provider_session_id in [None, Some(""), Some("   ")] {
        let mut repos = FakeRepos::default();
        let terminal_session_id = terminal(&mut repos, provider_session_id);
        let mut monica = facade(repos, RecordingSink::default());

        let error = monica
            .explanations()
            .create_topic("Topic", &terminal_session_id, Path::new("/artifacts"))
            .unwrap_err();

        assert!(matches!(error, ApplicationError::Conflict(_)));
        assert!(monica.explanations().list_explanations().unwrap().is_empty());
    }
}

#[test]
fn rejects_blank_title() {
    let mut repos = FakeRepos::default();
    let terminal_session_id = terminal(&mut repos, Some("claude-session-1"));
    let mut monica = facade(repos, RecordingSink::default());

    let error = monica
        .explanations()
        .create_topic("   ", &terminal_session_id, Path::new("/artifacts"))
        .unwrap_err();

    assert!(matches!(error, ApplicationError::Validation(_)));
    assert!(monica.explanations().list_explanations().unwrap().is_empty());
}
