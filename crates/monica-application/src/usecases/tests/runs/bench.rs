use super::*;

#[test]
fn default_bench_cwd_prefers_project_path() {
    let mut project = Project::from_repo("owner/repo");
    project.path = Some("/test/repo".to_string());
    assert_eq!(
        crate::usecases::runs::open_bench::default_bench_cwd(Some(&project), Some("/home/user")),
        "/test/repo"
    );
}

#[test]
fn default_bench_cwd_falls_back_to_home_dir_when_no_project_path() {
    let project = Project::from_repo("owner/repo");
    assert_eq!(
        crate::usecases::runs::open_bench::default_bench_cwd(Some(&project), Some("/home/user")),
        "/home/user"
    );
}

#[test]
fn default_bench_cwd_falls_back_to_tmp_when_no_project_and_no_home() {
    assert_eq!(
        crate::usecases::runs::open_bench::default_bench_cwd(None, None),
        "/tmp"
    );
}

#[test]
fn open_bench_falls_back_to_project_path_when_worktree_path_is_empty() {
    let mut repos = FakeRepos::default();
    let mut project = Project::from_repo("owner/repo");
    project.path = Some("/test/repo".to_string());
    repos.insert_project(project);
    let task_id = repos.insert_task_for_run(Some("owner/repo".to_string()));

    let run = repos
        .start_task_run(NewTaskRun {
            task_id: TaskId::from_store(task_id.clone()),
            agent: None,
            branch: None,
            worktree_path: Some(String::new()),
        })
        .unwrap();
    repos.set_primary_task_run(&task_id, &run.id).unwrap();

    let outputs = FakeTaskRunOutputs::default();
    let bench = open_bench(&mut repos, &outputs, &task_id).unwrap();
    assert!(bench.created);
    assert_eq!(bench.cwd, "/test/repo");
}

#[test]
fn open_bench_creates_bench_on_first_call_and_reuses_on_second() {
    let mut repos = FakeRepos::default();
    let mut project = Project::from_repo("owner/repo");
    project.path = Some("/test/repo".to_string());
    repos.insert_project(project);
    let task_id = repos.insert_task_for_run(Some("owner/repo".to_string()));
    let outputs = FakeTaskRunOutputs::default();

    let bench: TaskBench = open_bench(&mut repos, &outputs, &task_id).unwrap();
    assert!(bench.created);
    assert_eq!(bench.cwd, "/test/repo");
    assert_eq!(bench.task_id, task_id);

    let bench2: TaskBench = open_bench(&mut repos, &outputs, &task_id).unwrap();
    assert!(!bench2.created);
    assert_eq!(bench2.runspace_id, bench.runspace_id);
}

fn env_value<'a>(env: &'a [(String, String)], key: &str) -> Option<&'a str> {
    env.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
}

#[test]
fn open_bench_writes_hook_settings_into_resolved_cwd() {
    let mut repos = FakeRepos::default();
    let mut project = Project::from_repo("owner/repo");
    project.path = Some("/test/repo".to_string());
    repos.insert_project(project);
    let task_id = repos.insert_task_for_run(Some("owner/repo".to_string()));
    let outputs = FakeTaskRunOutputs::default();

    let bench = open_bench(&mut repos, &outputs, &task_id).unwrap();
    assert_eq!(env_value(&bench.env, "MONICA_CWD"), Some(bench.cwd.as_str()));
    assert_eq!(outputs.last_cwd().as_deref(), Some(bench.cwd.as_str()));
}

#[test]
fn task_shell_env_uses_existing_bench_cwd() {
    let mut repos = FakeRepos::default();
    let mut project = Project::from_repo("owner/repo");
    project.path = Some("/test/repo".to_string());
    repos.insert_project(project);
    let task_id = repos.insert_task_for_run(Some("owner/repo".to_string()));
    let outputs = FakeTaskRunOutputs::default();

    let bench = open_bench(&mut repos, &outputs, &task_id).unwrap();
    let env = crate::usecases::runs::task_shell_env(&repos, &outputs, &task_id).unwrap();
    assert_eq!(env_value(&env, "MONICA_CWD"), Some(bench.cwd.as_str()));
}

#[test]
fn task_shell_env_falls_back_to_worktree_when_no_bench() {
    let mut repos = FakeRepos::default();
    let mut project = Project::from_repo("owner/repo");
    project.path = Some("/test/repo".to_string());
    repos.insert_project(project);
    let task_id = repos.insert_task_for_run(Some("owner/repo".to_string()));

    // `/tmp` exists, so it passes the is_usable_worktree existence check.
    let run = repos
        .start_task_run(NewTaskRun {
            task_id: TaskId::from_store(task_id.clone()),
            agent: None,
            branch: None,
            worktree_path: Some("/tmp".to_string()),
        })
        .unwrap();
    repos.set_primary_task_run(&task_id, &run.id).unwrap();

    let outputs = FakeTaskRunOutputs::default();
    let env = crate::usecases::runs::task_shell_env(&repos, &outputs, &task_id).unwrap();
    assert_eq!(env_value(&env, "MONICA_CWD"), Some("/tmp"));
}

#[test]
fn task_shell_env_falls_back_to_project_path_when_no_bench_no_worktree() {
    let mut repos = FakeRepos::default();
    let mut project = Project::from_repo("owner/repo");
    project.path = Some("/test/repo".to_string());
    repos.insert_project(project);
    let task_id = repos.insert_task_for_run(Some("owner/repo".to_string()));

    let outputs = FakeTaskRunOutputs::default();
    let env = crate::usecases::runs::task_shell_env(&repos, &outputs, &task_id).unwrap();
    assert_eq!(env_value(&env, "MONICA_CWD"), Some("/test/repo"));
}
