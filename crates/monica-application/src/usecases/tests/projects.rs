use super::*;
use super::support::*;

#[test]
fn register_project_records_normalized_repo_and_branch() {
    let repos = FakeRepos::default();
    let project = register_project_with_default_branch(
        &repos,
        "Owner/Repo",
        Path::new("/repo"),
        Some("trunk"),
    )
    .unwrap();
    assert_eq!(project.id, "owner/repo");
    assert_eq!(project.default_branch, "trunk");
    assert_eq!(project.path.as_deref(), Some("/repo"));
}

