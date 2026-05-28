use super::work_items::parse_pr_number;
use crate::model::{
    Agent, ExternalRef, NewRun, NewWorkItem, PermissionMode, Project, Provider, RefType, Status,
    WorkItemKind,
};
use crate::Db;
use rusqlite::params;
use serde_json::json;

fn sample_project() -> Project {
    Project::from_repo("ashigirl96/monica")
}

fn dev_item(title: &str) -> NewWorkItem {
    NewWorkItem::new(WorkItemKind::Development, title)
}

fn new_run(work_item_id: &str) -> NewRun {
    NewRun {
        work_item_id: work_item_id.to_string(),
        agent: Some(Agent::Claude),
        branch: Some("mon-1".to_string()),
        worktree_path: Some("/tmp/wt".to_string()),
    }
}

fn insert_run_at(db: &Db, id: &str, work_item_id: &str, branch: Option<&str>, created_at: &str) {
    db.conn()
        .execute(
            "INSERT INTO runs
                   (id, work_item_id, branch, status, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![
                id,
                work_item_id,
                branch,
                Status::Running.as_str(),
                created_at
            ],
        )
        .unwrap();
}

#[test]
fn migrate_is_idempotent() {
    let mut conn = rusqlite::Connection::open_in_memory().unwrap();
    crate::migrations::migrate(&mut conn).unwrap();
    crate::migrations::migrate(&mut conn).unwrap();

    let version: i64 = conn
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .unwrap();
    assert_eq!(version, 4);

    let tables: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type = 'table'
                 AND name IN ('mon_counter','run_counter','work_items','runs','events','external_refs','projects')",
                [],
                |r| r.get(0),
            )
            .unwrap();
    assert_eq!(tables, 7);
}

#[test]
fn work_item_round_trip() {
    let mut db = Db::open_in_memory().unwrap();

    let mut new = dev_item("first task");
    new.status = Status::Ready;
    new.body = "do the thing".to_string();
    new.project_id = Some("ashigirl96/monica".to_string());
    new.labels = vec!["m0".to_string(), "core".to_string()];
    new.details = json!({ "priority": "high" });
    new.source = Some(json!({ "via": "manual" }));

    let created = db.insert_work_item(new).unwrap();
    assert_eq!(created.id, "MON-1");
    assert_eq!(created.status, Status::Ready);

    let fetched = db.get_work_item("MON-1").unwrap().unwrap();
    assert_eq!(fetched, created);
    assert_eq!(fetched.labels, vec!["m0".to_string(), "core".to_string()]);
    assert_eq!(fetched.details, json!({ "priority": "high" }));
    assert_eq!(fetched.source, Some(json!({ "via": "manual" })));

    let listed = db.list_work_items().unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0], created);

    std::thread::sleep(std::time::Duration::from_millis(5));
    db.update_status("MON-1", Status::Running).unwrap();
    let updated = db.get_work_item("MON-1").unwrap().unwrap();
    assert_eq!(updated.status, Status::Running);
    assert!(updated.updated_at > created.updated_at);
    assert_eq!(updated.created_at, created.created_at);
}

#[test]
fn update_status_unknown_id_errors() {
    let db = Db::open_in_memory().unwrap();
    assert!(db.update_status("MON-999", Status::Done).is_err());
}

#[test]
fn start_run_sets_run_and_work_item_to_setting_up() {
    let mut db = Db::open_in_memory().unwrap();
    let item = db
        .insert_work_item({
            let mut i = dev_item("runnable");
            i.status = Status::Ready;
            i
        })
        .unwrap();

    let run = db.start_run(new_run(&item.id)).unwrap();
    assert_eq!(run.id, "run-1");
    assert_eq!(run.status, Status::SettingUp);
    assert_eq!(run.agent.as_deref(), Some("claude"));
    assert_eq!(run.branch.as_deref(), Some("mon-1"));
    assert_eq!(run.worktree_path.as_deref(), Some("/tmp/wt"));

    assert_eq!(db.get_run("run-1").unwrap().unwrap(), run);
    assert_eq!(
        db.get_work_item(&item.id).unwrap().unwrap().status,
        Status::SettingUp,
        "start_run must move the work item to setting_up in the same transaction"
    );
}

#[test]
fn run_ids_increase_monotonically() {
    let mut db = Db::open_in_memory().unwrap();
    let item = db.insert_work_item(dev_item("a")).unwrap();
    let r1 = db.start_run(new_run(&item.id)).unwrap();
    let r2 = db.start_run(new_run(&item.id)).unwrap();
    assert_eq!((r1.id.as_str(), r2.id.as_str()), ("run-1", "run-2"));
}

#[test]
fn finish_run_updates_run_and_work_item_together() {
    let mut db = Db::open_in_memory().unwrap();
    let item = db.insert_work_item(dev_item("a")).unwrap();
    let run = db.start_run(new_run(&item.id)).unwrap();

    db.finish_run(&run.id, &item.id, Status::Running).unwrap();
    assert_eq!(
        db.get_run(&run.id).unwrap().unwrap().status,
        Status::Running
    );
    assert_eq!(
        db.get_work_item(&item.id).unwrap().unwrap().status,
        Status::Running
    );

    assert!(db.finish_run("run-999", &item.id, Status::Failed).is_err());
}

#[test]
fn finish_run_unknown_work_item_rolls_back() {
    let mut db = Db::open_in_memory().unwrap();
    let item = db.insert_work_item(dev_item("a")).unwrap();
    let run = db.start_run(new_run(&item.id)).unwrap();

    // Valid run id, wrong work item: the work item update finds nothing and the whole tx must
    // roll back, so the run must not drift to `running` on its own.
    assert!(db.finish_run(&run.id, "MON-999", Status::Running).is_err());
    assert_eq!(
        db.get_run(&run.id).unwrap().unwrap().status,
        Status::SettingUp
    );
    assert_eq!(
        db.get_work_item(&item.id).unwrap().unwrap().status,
        Status::SettingUp
    );
}

#[test]
fn set_run_settings_path_records_and_bumps_updated_at() {
    let mut db = Db::open_in_memory().unwrap();
    let item = db.insert_work_item(dev_item("settings target")).unwrap();
    let run = db.start_run(new_run(&item.id)).unwrap();

    // Force a measurable gap so updated_at must move past start_run's timestamp.
    std::thread::sleep(std::time::Duration::from_millis(5));
    db.set_run_settings_path(&run.id, "/abs/runs/run-1/claude-settings.json")
        .unwrap();

    let fetched = db.get_run(&run.id).unwrap().unwrap();
    assert_eq!(
        fetched.settings_path.as_deref(),
        Some("/abs/runs/run-1/claude-settings.json")
    );
    assert!(
        fetched.updated_at > run.updated_at,
        "settings_path update must bump updated_at"
    );
    assert_eq!(
        fetched.status, run.status,
        "set_run_settings_path is not a status transition"
    );
}

#[test]
fn set_run_settings_path_errors_on_unknown_run() {
    let db = Db::open_in_memory().unwrap();
    let err = db.set_run_settings_path("run-999", "/x").unwrap_err();
    assert!(format!("{err:#}").contains("run not found"), "{err:#}");
}

#[test]
fn start_run_unknown_work_item_leaves_no_phantom_run() {
    let mut db = Db::open_in_memory().unwrap();
    assert!(db.start_run(new_run("MON-999")).is_err());
    assert!(
        db.get_run("run-1").unwrap().is_none(),
        "a rolled-back start_run must not leak a run row"
    );
}

#[test]
fn get_missing_work_item_is_none() {
    let db = Db::open_in_memory().unwrap();
    assert!(db.get_work_item("MON-1").unwrap().is_none());
}

#[test]
fn delete_work_item_refuses_owned_runs() {
    let mut db = Db::open_in_memory().unwrap();
    let item = db
        .insert_work_item_with_ref(
            dev_item("delete me"),
            ExternalRef::new(
                String::new(),
                RefType::GithubIssue,
                Some("ashigirl96/monica".to_string()),
                Some(44),
                Some("https://github.com/ashigirl96/monica/issues/44".to_string()),
            ),
        )
        .unwrap();
    let run = db.start_run(new_run(&item.id)).unwrap();
    db.insert_event(Some(&item.id), None, "mark", &json!({ "via": "test" }))
        .unwrap();
    db.insert_event(None, Some(&run.id), "hook", &json!({ "via": "test" }))
        .unwrap();

    let err = db.delete_work_item(&item.id).unwrap_err();
    assert!(
        format!("{err:#}").contains("cleanup-aware issue delete path"),
        "{err:#}"
    );
    assert!(db.get_work_item(&item.id).unwrap().is_some());
    assert!(db.get_run(&run.id).unwrap().is_some());
    assert_eq!(db.list_external_refs(&item.id).unwrap().len(), 1);

    let event_count: i64 = db
        .conn()
        .query_row("SELECT count(*) FROM events", [], |r| r.get(0))
        .unwrap();
    assert_eq!(event_count, 2);
}

#[test]
fn delete_work_item_removes_unrun_item_rows() {
    let mut db = Db::open_in_memory().unwrap();
    let item = db
        .insert_work_item_with_ref(
            dev_item("delete me"),
            ExternalRef::new(
                String::new(),
                RefType::GithubIssue,
                Some("ashigirl96/monica".to_string()),
                Some(44),
                Some("https://github.com/ashigirl96/monica/issues/44".to_string()),
            ),
        )
        .unwrap();
    db.insert_event(Some(&item.id), None, "mark", &json!({ "via": "test" }))
        .unwrap();

    let deleted = db.delete_work_item(&item.id).unwrap();
    assert_eq!(deleted.id, item.id);
    assert!(db.get_work_item(&item.id).unwrap().is_none());
    assert!(db.list_external_refs(&item.id).unwrap().is_empty());

    let event_count: i64 = db
        .conn()
        .query_row("SELECT count(*) FROM events", [], |r| r.get(0))
        .unwrap();
    assert_eq!(event_count, 0);
}

#[test]
fn delete_work_item_errors_on_unknown_id() {
    let mut db = Db::open_in_memory().unwrap();
    let err = db.delete_work_item("MON-999").unwrap_err();
    assert!(
        format!("{err:#}").contains("work item not found: MON-999"),
        "{err:#}"
    );
}

#[test]
fn list_issue_statuses_uses_effective_repo_and_filters() {
    let mut db = Db::open_in_memory().unwrap();
    let mut project = sample_project();
    project.repo = "ashigirl96/monica-renamed".to_string();
    db.upsert_project(&project).unwrap();

    let linked = db
        .insert_work_item_with_ref(
            {
                let mut item = dev_item("linked");
                item.status = Status::Ready;
                item.project_id = Some("ashigirl96/monica".to_string());
                item
            },
            ExternalRef::new(
                String::new(),
                RefType::GithubIssue,
                Some("ashigirl96/monica-stale".to_string()),
                Some(17),
                None,
            ),
        )
        .unwrap();
    let unlinked = db
        .insert_work_item_with_ref(
            {
                let mut item = dev_item("unlinked");
                item.status = Status::NeedApproval;
                item
            },
            ExternalRef::new(
                String::new(),
                RefType::GithubIssue,
                Some("ashigirl96/other".to_string()),
                Some(18),
                None,
            ),
        )
        .unwrap();

    let all = db.list_issue_statuses(None, None).unwrap();
    assert_eq!(all.len(), 2);
    assert_eq!(all[0].id, linked.id);
    assert_eq!(all[0].project.as_deref(), Some("ashigirl96/monica-renamed"));
    assert_eq!(all[0].github_issue_number, Some(17));
    assert_eq!(all[1].id, unlinked.id);
    assert_eq!(all[1].project.as_deref(), Some("ashigirl96/other"));

    let ready = db.list_issue_statuses(Some(Status::Ready), None).unwrap();
    assert_eq!(ready.len(), 1);
    assert_eq!(ready[0].id, linked.id);

    let filtered = db
        .list_issue_statuses(None, Some("ashigirl96/monica-renamed"))
        .unwrap();
    assert_eq!(filtered.len(), 1);
    assert_eq!(filtered[0].id, linked.id);
    assert!(db
        .list_issue_statuses(None, Some("ashigirl96/monica-stale"))
        .unwrap()
        .is_empty());
}

#[test]
fn list_issue_statuses_picks_latest_run_deterministically() {
    let mut db = Db::open_in_memory().unwrap();
    let item = db
        .insert_work_item_with_ref(
            dev_item("tracked"),
            ExternalRef::new(
                String::new(),
                RefType::GithubIssue,
                Some("ashigirl96/monica".to_string()),
                Some(17),
                None,
            ),
        )
        .unwrap();

    insert_run_at(
        &db,
        "run-9",
        &item.id,
        Some("monica/old"),
        "2026-05-28T01:00:00.000Z",
    );
    insert_run_at(
        &db,
        "run-10",
        &item.id,
        Some("monica/newer"),
        "2026-05-28T02:00:00.000Z",
    );
    insert_run_at(
        &db,
        "run-11",
        &item.id,
        Some("monica/tiebreak"),
        "2026-05-28T02:00:00.000Z",
    );

    let rows = db.list_issue_statuses(None, None).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].branch.as_deref(), Some("monica/tiebreak"));
}

#[test]
fn list_issue_statuses_handles_missing_ref_and_run() {
    let mut db = Db::open_in_memory().unwrap();
    let item = db.insert_work_item(dev_item("plain")).unwrap();

    let rows = db.list_issue_statuses(None, None).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, item.id);
    assert_eq!(rows[0].project, None);
    assert_eq!(rows[0].github_issue_number, None);
    assert_eq!(rows[0].branch, None);
}

#[test]
fn list_issue_statuses_uses_latest_issue_ref() {
    let mut db = Db::open_in_memory().unwrap();
    let item = db.insert_work_item(dev_item("tracked")).unwrap();
    db.save_external_ref(&ExternalRef::new(
        item.id.clone(),
        RefType::GithubIssue,
        Some("ashigirl96/first".to_string()),
        Some(17),
        None,
    ))
    .unwrap();
    db.save_external_ref(&ExternalRef::new(
        item.id.clone(),
        RefType::GithubIssue,
        Some("ashigirl96/second".to_string()),
        Some(18),
        None,
    ))
    .unwrap();

    let rows = db.list_issue_statuses(None, None).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].project.as_deref(), Some("ashigirl96/second"));
    assert_eq!(rows[0].github_issue_number, Some(18));
}

#[test]
fn mon_ids_increase_monotonically() {
    let mut db = Db::open_in_memory().unwrap();
    let a = db.insert_work_item(dev_item("a")).unwrap();
    let b = db.insert_work_item(dev_item("b")).unwrap();
    let c = db.insert_work_item(dev_item("c")).unwrap();
    assert_eq!(
        (a.id.as_str(), b.id.as_str(), c.id.as_str()),
        ("MON-1", "MON-2", "MON-3")
    );
}

#[test]
fn mon_ids_are_not_reused_after_deletion() {
    let mut db = Db::open_in_memory().unwrap();
    db.insert_work_item(dev_item("a")).unwrap();
    db.insert_work_item(dev_item("b")).unwrap();
    db.conn()
        .execute("DELETE FROM work_items WHERE id = 'MON-2'", [])
        .unwrap();

    let next = db.insert_work_item(dev_item("c")).unwrap();
    assert_eq!(next.id, "MON-3");
}

#[test]
fn insert_work_item_with_ref_links_atomically() {
    let mut db = Db::open_in_memory().unwrap();
    let external = ExternalRef::new(
        String::new(),
        RefType::GithubIssue,
        Some("ashigirl96/monica".to_string()),
        Some(9),
        Some("https://github.com/ashigirl96/monica/issues/9".to_string()),
    );
    let item = db
        .insert_work_item_with_ref(dev_item("tracked"), external)
        .unwrap();
    assert_eq!(item.id, "MON-1");

    let refs = db.list_external_refs("MON-1").unwrap();
    assert_eq!(refs.len(), 1);
    assert_eq!(
        refs[0].work_item_id, "MON-1",
        "ref must adopt the allocated id"
    );
    assert_eq!(refs[0].ref_type, RefType::GithubIssue);
    assert_eq!(refs[0].repo.as_deref(), Some("ashigirl96/monica"));
    assert_eq!(refs[0].number, Some(9));
}

#[test]
fn external_ref_round_trip() {
    let mut db = Db::open_in_memory().unwrap();
    let item = db.insert_work_item(dev_item("tracked")).unwrap();

    let r = ExternalRef::new(
        item.id.clone(),
        RefType::GithubIssue,
        Some("ashigirl96/monica".to_string()),
        Some(9),
        Some("https://github.com/ashigirl96/monica/issues/9".to_string()),
    );
    let row_id = db.save_external_ref(&r).unwrap();
    assert!(row_id > 0);

    let refs = db.list_external_refs(&item.id).unwrap();
    assert_eq!(refs.len(), 1);
    assert_eq!(refs[0].ref_type, RefType::GithubIssue);
    assert_eq!(refs[0].repo.as_deref(), Some("ashigirl96/monica"));
    assert_eq!(refs[0].number, Some(9));
    assert_eq!(
        refs[0].url.as_deref(),
        Some("https://github.com/ashigirl96/monica/issues/9")
    );
}

#[test]
fn project_round_trip() {
    let db = Db::open_in_memory().unwrap();

    let mut p = sample_project();
    p.path = Some("/Users/dev/monica".to_string());

    let created = db.upsert_project(&p).unwrap();
    assert_eq!(created.id, "ashigirl96/monica");
    assert_eq!(created.name, "monica");
    assert_eq!(created.provider, Provider::Github);
    assert_eq!(created.agent_default, Agent::Claude);
    assert_eq!(created.agent_permission_mode, PermissionMode::Plan);
    assert_eq!(created.setup_timeout_sec, 600);
    assert!(created.hooks_claude);
    assert_eq!(created.path.as_deref(), Some("/Users/dev/monica"));
    assert!(
        !created.created_at.is_empty(),
        "created_at should be filled by the DB default"
    );
    assert!(
        !created.updated_at.is_empty(),
        "updated_at should be filled by the DB default"
    );

    let fetched = db.get_project("ashigirl96/monica").unwrap().unwrap();
    assert_eq!(fetched, created);

    let listed = db.list_projects().unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0], created);
}

#[test]
fn list_projects_empty_is_ok() {
    let db = Db::open_in_memory().unwrap();
    assert!(db.list_projects().unwrap().is_empty());
    assert!(db.get_project("nobody/nothing").unwrap().is_none());
}

#[test]
fn set_project_field_coerces_and_validates() {
    let db = Db::open_in_memory().unwrap();
    db.upsert_project(&sample_project()).unwrap();
    let id = "ashigirl96/monica";

    db.set_project_field(id, "default_branch", "develop")
        .unwrap();
    db.set_project_field(id, "branch", "master").unwrap();
    db.set_project_field(id, "agent_permission_mode", "acceptEdits")
        .unwrap();
    db.set_project_field(id, "setup_timeout_sec", "900")
        .unwrap();
    db.set_project_field(id, "hooks_claude", "false").unwrap();
    db.set_project_field(id, "worktree_root", "/Users/dev/.worktrees/monica")
        .unwrap();

    let p = db.get_project(id).unwrap().unwrap();
    assert_eq!(p.default_branch, "master");
    assert_eq!(p.agent_permission_mode, PermissionMode::AcceptEdits);
    assert_eq!(p.setup_timeout_sec, 900);
    assert!(!p.hooks_claude);
    assert_eq!(
        p.worktree_root.as_deref(),
        Some("/Users/dev/.worktrees/monica")
    );

    assert!(db
        .set_project_field(id, "agent_permission_mode", "bogus")
        .is_err());
    assert!(db
        .set_project_field(id, "setup_timeout_sec", "abc")
        .is_err());
    assert!(db.set_project_field(id, "setup_timeout_sec", "-5").is_err());
    assert!(db.set_project_field(id, "setup_timeout_sec", "0").is_err());
    assert!(db.set_project_field(id, "hooks_claude", "maybe").is_err());
    assert!(db.set_project_field(id, "path", "").is_err());
    assert!(db.set_project_field(id, "worktree_root", "").is_err());
    assert!(db.set_project_field(id, "id", "other/repo").is_err());
    assert!(db.set_project_field(id, "nonexistent", "x").is_err());
    assert!(db.set_project_field("missing/repo", "name", "x").is_err());
}

#[test]
fn reinit_preserves_tweaked_config_and_tracks_path() {
    let db = Db::open_in_memory().unwrap();
    let mut p = sample_project();
    p.path = Some("/Users/dev/monica".to_string());
    db.upsert_project(&p).unwrap();

    db.set_project_field("ashigirl96/monica", "name", "Custom")
        .unwrap();
    db.set_project_field("ashigirl96/monica", "setup_timeout_sec", "900")
        .unwrap();
    db.set_project_field("ashigirl96/monica", "default_branch", "develop")
        .unwrap();

    let mut reinit = Project::from_repo("ashigirl96/monica");
    reinit.path = Some("/Users/dev/monica-moved".to_string());
    let after = db.upsert_project(&reinit).unwrap();

    assert_eq!(after.name, "Custom", "set value must survive re-init");
    assert_eq!(
        after.setup_timeout_sec, 900,
        "set value must survive re-init"
    );
    assert_eq!(
        after.default_branch, "develop",
        "set value must survive re-init"
    );
    assert_eq!(
        after.path.as_deref(),
        Some("/Users/dev/monica-moved"),
        "path tracks the new checkout"
    );
}

#[test]
fn reinit_replaces_untouched_main_with_detected_default_branch() {
    let db = Db::open_in_memory().unwrap();
    let mut p = sample_project();
    p.path = Some("/Users/dev/monica".to_string());
    assert_eq!(p.default_branch, "main");
    db.upsert_project(&p).unwrap();

    let mut reinit = Project::from_repo("ashigirl96/monica");
    reinit.path = Some("/Users/dev/monica-moved".to_string());
    reinit.default_branch = "master".to_string();
    let after = db.upsert_project(&reinit).unwrap();

    assert_eq!(after.default_branch, "master");
    assert_eq!(after.path.as_deref(), Some("/Users/dev/monica-moved"));
}

#[test]
fn permission_mode_as_str_matches_serde() {
    for mode in [
        PermissionMode::Default,
        PermissionMode::Plan,
        PermissionMode::AcceptEdits,
        PermissionMode::BypassPermissions,
    ] {
        assert_eq!(mode.as_str().parse::<PermissionMode>().unwrap(), mode);
        let json = serde_json::to_string(&mode).unwrap();
        assert_eq!(json, format!("\"{}\"", mode.as_str()));
    }
    assert!("dontAsk".parse::<PermissionMode>().is_err());
}

#[test]
fn from_repo_derives_name_from_last_segment() {
    assert_eq!(Project::from_repo("ashigirl96/monica").name, "monica");
    // A trailing slash must not produce an empty name.
    assert_eq!(Project::from_repo("ashigirl96/monica/").name, "monica");
}

#[test]
fn provider_and_agent_round_trip() {
    assert_eq!(
        Provider::Github.as_str().parse::<Provider>().unwrap(),
        Provider::Github
    );
    assert!("gitlab".parse::<Provider>().is_err());
    assert_eq!(
        Agent::Claude.as_str().parse::<Agent>().unwrap(),
        Agent::Claude
    );
    assert!("codex".parse::<Agent>().is_err());
}

#[test]
fn status_string_conversion_round_trips() {
    let all = [
        Status::Inbox,
        Status::Ready,
        Status::SettingUp,
        Status::Running,
        Status::NeedApproval,
        Status::Stopped,
        Status::Failed,
        Status::PrOpen,
        Status::Done,
        Status::Archived,
    ];
    for s in all {
        assert_eq!(s.as_str().parse::<Status>().unwrap(), s);
    }
    assert!("bogus".parse::<Status>().is_err());
    assert_eq!(
        WorkItemKind::Development
            .as_str()
            .parse::<WorkItemKind>()
            .unwrap(),
        WorkItemKind::Development
    );
    assert!("nope".parse::<WorkItemKind>().is_err());
    assert_eq!(
        RefType::GithubIssue.as_str().parse::<RefType>().unwrap(),
        RefType::GithubIssue
    );
    assert!("nope".parse::<RefType>().is_err());
}

#[test]
fn status_parse_token_accepts_dashes_and_underscores() {
    assert_eq!(
        Status::parse_token("need-approval").unwrap(),
        Status::NeedApproval
    );
    assert_eq!(
        Status::parse_token("need_approval").unwrap(),
        Status::NeedApproval
    );
    assert_eq!(Status::parse_token("pr-open").unwrap(), Status::PrOpen);
    assert_eq!(Status::parse_token("running").unwrap(), Status::Running);
    assert!(Status::parse_token("bogus").is_err());
}

#[test]
fn ref_type_pull_request_round_trips() {
    assert_eq!(RefType::GithubPullRequest.as_str(), "github_pull_request");
    assert_eq!(
        "github_pull_request".parse::<RefType>().unwrap(),
        RefType::GithubPullRequest
    );
}

#[test]
fn parse_pr_number_extracts_after_pull_segment() {
    assert_eq!(parse_pr_number("https://github.com/o/r/pull/99"), Some(99));
    assert_eq!(
        parse_pr_number("https://github.com/o/r/pull/99/files"),
        Some(99)
    );
    assert_eq!(parse_pr_number("https://github.com/o/r/pulls/12"), Some(12));
    assert_eq!(parse_pr_number("https://github.com/o/r/issues/99"), None);
    assert_eq!(parse_pr_number("not a url"), None);
    assert_eq!(parse_pr_number("https://github.com/o/r/pull/abc"), None);
    assert_eq!(parse_pr_number("https://github.com/o/r/pull/0"), None);
}

#[test]
fn insert_event_round_trips_and_filters_by_work_item() {
    let mut db = Db::open_in_memory().unwrap();
    let a = db.insert_work_item(dev_item("a")).unwrap();
    let b = db.insert_work_item(dev_item("b")).unwrap();

    let ev = db
        .insert_event(
            Some(&a.id),
            None,
            "claude_hook",
            &json!({ "hook_event_name": "Stop" }),
        )
        .unwrap();
    assert!(ev.id > 0);
    assert_eq!(ev.work_item_id.as_deref(), Some(a.id.as_str()));
    assert_eq!(ev.run_id, None);
    assert_eq!(ev.kind, "claude_hook");
    assert_eq!(ev.payload, json!({ "hook_event_name": "Stop" }));
    assert!(!ev.created_at.is_empty());

    db.insert_event(Some(&b.id), None, "mark", &json!({ "x": 1 }))
        .unwrap();

    assert_eq!(db.list_events(None).unwrap().len(), 2);
    let a_events = db.list_events(Some(&a.id)).unwrap();
    assert_eq!(a_events.len(), 1);
    assert_eq!(a_events[0].kind, "claude_hook");
}

#[test]
fn insert_event_allows_null_work_item_and_run() {
    let db = Db::open_in_memory().unwrap();
    let ev = db
        .insert_event(None, None, "claude_hook", &json!({ "raw": "x" }))
        .unwrap();
    assert_eq!(ev.work_item_id, None);
    assert_eq!(ev.run_id, None);
}

#[test]
fn apply_hook_status_updates_work_item_and_matching_run() {
    let mut db = Db::open_in_memory().unwrap();
    let item = db
        .insert_work_item({
            let mut i = dev_item("a");
            i.status = Status::Ready;
            i
        })
        .unwrap();
    let run = db.start_run(new_run(&item.id)).unwrap();

    db.apply_hook_status(&item.id, Some(&run.id), Status::Running)
        .unwrap();
    assert_eq!(
        db.get_work_item(&item.id).unwrap().unwrap().status,
        Status::Running
    );
    assert_eq!(
        db.get_run(&run.id).unwrap().unwrap().status,
        Status::Running
    );
}

#[test]
fn apply_hook_status_ignores_run_of_another_work_item() {
    let mut db = Db::open_in_memory().unwrap();
    let a = db
        .insert_work_item({
            let mut i = dev_item("a");
            i.status = Status::Ready;
            i
        })
        .unwrap();
    let run_a = db.start_run(new_run(&a.id)).unwrap();
    let b = db
        .insert_work_item({
            let mut i = dev_item("b");
            i.status = Status::Ready;
            i
        })
        .unwrap();

    // Mark b but pass run_a: the `AND work_item_id` guard must leave run_a (and a) untouched.
    db.apply_hook_status(&b.id, Some(&run_a.id), Status::Stopped)
        .unwrap();
    assert_eq!(
        db.get_work_item(&b.id).unwrap().unwrap().status,
        Status::Stopped
    );
    assert_eq!(
        db.get_run(&run_a.id).unwrap().unwrap().status,
        Status::SettingUp
    );
    assert_eq!(
        db.get_work_item(&a.id).unwrap().unwrap().status,
        Status::SettingUp
    );
}

#[test]
fn apply_hook_status_unknown_work_item_errors_but_unknown_run_is_harmless() {
    let mut db = Db::open_in_memory().unwrap();
    assert!(db
        .apply_hook_status("MON-999", None, Status::Stopped)
        .is_err());

    let item = db.insert_work_item(dev_item("a")).unwrap();
    db.apply_hook_status(&item.id, Some("run-nope"), Status::Stopped)
        .unwrap();
    assert_eq!(
        db.get_work_item(&item.id).unwrap().unwrap().status,
        Status::Stopped
    );
}

#[test]
fn mark_work_item_sets_status_phase_pr_ref_and_event() {
    let mut db = Db::open_in_memory().unwrap();
    let item = db.insert_work_item(dev_item("a")).unwrap();

    db.mark_work_item(&item.id, Status::NeedApproval, Some("Plan ready"), None)
        .unwrap();
    let after = db.get_work_item(&item.id).unwrap().unwrap();
    assert_eq!(after.status, Status::NeedApproval);
    assert_eq!(after.phase.as_deref(), Some("Plan ready"));

    db.mark_work_item(
        &item.id,
        Status::PrOpen,
        None,
        Some("https://github.com/o/r/pull/99"),
    )
    .unwrap();
    let after = db.get_work_item(&item.id).unwrap().unwrap();
    assert_eq!(after.status, Status::PrOpen);
    assert_eq!(
        after.phase.as_deref(),
        Some("Plan ready"),
        "note=None keeps the prior phase"
    );

    let refs = db.list_external_refs(&item.id).unwrap();
    assert_eq!(refs.len(), 1);
    assert_eq!(refs[0].ref_type, RefType::GithubPullRequest);
    assert_eq!(refs[0].number, Some(99));
    assert_eq!(
        refs[0].url.as_deref(),
        Some("https://github.com/o/r/pull/99")
    );

    let events = db.list_events(Some(&item.id)).unwrap();
    assert_eq!(events.len(), 2);
    assert!(events.iter().all(|e| e.kind == "mark"));
}

#[test]
fn mark_work_item_pr_ref_does_not_pollute_issue_status_query() {
    let mut db = Db::open_in_memory().unwrap();
    let item = db
        .insert_work_item_with_ref(
            dev_item("tracked"),
            ExternalRef::new(
                String::new(),
                RefType::GithubIssue,
                Some("o/r".to_string()),
                Some(7),
                None,
            ),
        )
        .unwrap();
    db.mark_work_item(
        &item.id,
        Status::PrOpen,
        None,
        Some("https://github.com/o/r/pull/99"),
    )
    .unwrap();

    let rows = db.list_issue_statuses(None, None).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(
        rows[0].github_issue_number,
        Some(7),
        "the PR ref must not shadow the github_issue number"
    );
    assert_eq!(rows[0].status, Status::PrOpen);
}

#[test]
fn mark_work_item_unknown_id_errors() {
    let mut db = Db::open_in_memory().unwrap();
    assert!(db
        .mark_work_item("MON-999", Status::PrOpen, None, None)
        .is_err());
}

#[test]
fn now_iso_returns_utc_millisecond_timestamp() {
    let db = Db::open_in_memory().unwrap();
    let ts = db.now_iso().unwrap();
    // Same shape as the schema column defaults: `YYYY-MM-DDTHH:MM:SS.mmmZ`.
    assert!(ts.ends_with('Z'), "must end in Z: {ts}");
    assert_eq!(ts.len(), 24, "must be 24 chars: {ts}");
    assert_eq!(&ts[4..5], "-");
    assert_eq!(&ts[10..11], "T");
}

#[test]
fn db_path_respects_monica_home() {
    let _env = crate::paths::test_env_guard();
    std::env::remove_var("MONICA_HOME");
    std::env::set_var("HOME", "/tmp/monica-home-test");
    assert_eq!(
        crate::paths::db_path().unwrap(),
        std::path::Path::new("/tmp/monica-home-test/monica/db/monica.db")
    );

    std::env::set_var("MONICA_HOME", "/tmp/monica-override");
    assert_eq!(
        crate::paths::db_path().unwrap(),
        std::path::Path::new("/tmp/monica-override/db/monica.db")
    );
    std::env::remove_var("MONICA_HOME");
}
