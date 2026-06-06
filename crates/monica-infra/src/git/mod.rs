mod worktree;

pub use worktree::GitCliGateway;

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::process::Command;

    use monica_core::{ExternalRef, NewTask, Project, RefType, TaskKind, TaskStatus};

    use crate::filesystem::{paths, FsRunArtifacts};
    use crate::process::ProcessSetupRunner;
    use crate::sqlite::SqliteStore;
    use crate::test_support::{init_repo, Tmp};

    use super::GitCliGateway;

    #[test]
    fn run_issue_creates_real_git_worktree_through_gateway() {
        let _guard = paths::test_env_guard();
        let home = Tmp::new("git-home");
        std::env::set_var("MONICA_HOME", home.path());

        let repo = Tmp::new("git-repo");
        init_repo(repo.path());

        let mut db = SqliteStore::open_in_memory().unwrap();
        let mut project = Project::from_repo("owner/repo");
        project.path = Some(repo.path().to_string_lossy().into_owned());
        project.default_branch = "main".to_string();
        db.upsert_project(&project).unwrap();

        let mut task = NewTask::new(TaskKind::Development, "real git");
        task.status = TaskStatus::Ready;
        task.project_id = Some(project.id.clone());
        let item = db
            .insert_task_with_ref(
                task,
                ExternalRef::new(
                    "",
                    RefType::GithubIssue,
                    Some(project.id.clone()),
                    Some(42),
                    None,
                ),
            )
            .unwrap();

        let report = monica_core::run_issue(
            &mut db,
            &GitCliGateway,
            &ProcessSetupRunner,
            &FsRunArtifacts,
            &item.id,
            None,
        )
        .unwrap();

        assert_eq!(report.branch, "issue-42");
        assert!(Path::new(&report.worktree_path).join(".git").exists());
        assert!(branch_exists(repo.path(), "issue-42"));
    }

    fn branch_exists(repo: &Path, branch: &str) -> bool {
        Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(["show-ref", "--verify", "--quiet"])
            .arg(format!("refs/heads/{branch}"))
            .status()
            .unwrap()
            .success()
    }

}
