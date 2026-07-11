use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::{anyhow, Result};
use monica_domain::{Explanation, ExplanationMode};
use oxhttp::model::{HeaderName, Method, Request, Response, Status};

use super::explanations::ExplanationSource;
use super::handle_request_with;

static TEST_DIR_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
struct FakeSource {
    explanations: Vec<Explanation>,
    fail_list: bool,
    fail_get: bool,
}

impl ExplanationSource for FakeSource {
    fn list_explanations(&self) -> Result<Vec<Explanation>> {
        if self.fail_list {
            Err(anyhow!("database at /secret/list.db failed"))
        } else {
            Ok(self.explanations.clone())
        }
    }

    fn get_explanation(&self, id: &str) -> Result<Option<Explanation>> {
        if self.fail_get {
            Err(anyhow!("database at /secret/get.db failed"))
        } else {
            Ok(self
                .explanations
                .iter()
                .find(|explanation| explanation.id == id)
                .cloned())
        }
    }
}

struct TestDir(PathBuf);

impl TestDir {
    fn new() -> Self {
        let sequence = TEST_DIR_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "monica-web-test-{}-{sequence}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn explanation(root: &Path, id: &str, title: &str) -> Explanation {
    Explanation {
        id: id.to_string(),
        title: title.to_string(),
        mode: ExplanationMode::Diff,
        artifact_path: root.join(id).to_string_lossy().into_owned(),
        provider_session_id: "provider-secret".to_string(),
        terminal_session_id: "terminal-secret".to_string(),
        created_at: "2026-07-11T01:02:03.000Z".to_string(),
    }
}

fn request(method: Method, path: &str) -> Request {
    Request::builder(method, format!("http://localhost{path}").parse().unwrap()).build()
}

fn handle(method: Method, path: &str, source: &dyn ExplanationSource, root: &Path) -> Response {
    handle_request_with(&request(method, path), source, &|| Ok(root.to_path_buf()))
}

fn header(response: &Response, name: &str) -> String {
    let name = name.parse::<HeaderName>().unwrap();
    String::from_utf8(response.header(&name).unwrap().as_ref().to_vec()).unwrap()
}

#[test]
fn root_keeps_the_existing_hello_response() {
    let root = TestDir::new();
    let response = handle(Method::GET, "/", &FakeSource::default(), root.path());

    assert_eq!(response.status(), Status::OK);
    assert_eq!(response.into_body().to_string().unwrap(), "Hello from Monica");
}

#[test]
fn list_renders_links_and_escapes_database_text() {
    let root = TestDir::new();
    let record = explanation(
        root.path(),
        "exp-1",
        "Design <script>alert(\"x\")</script> & review's notes",
    );
    fs::create_dir_all(&record.artifact_path).unwrap();
    fs::write(Path::new(&record.artifact_path).join("index.html"), "ready").unwrap();
    let source = FakeSource {
        explanations: vec![record],
        ..FakeSource::default()
    };

    let response = handle(Method::GET, "/explanations", &source, root.path());

    assert_eq!(response.status(), Status::OK);
    assert_eq!(header(&response, "content-type"), "text/html; charset=utf-8");
    assert_eq!(header(&response, "cache-control"), "no-store");
    assert_eq!(header(&response, "x-content-type-options"), "nosniff");
    let body = response.into_body().to_string().unwrap();
    assert!(body.contains("href=\"/explanations/exp-1\""));
    assert!(body.contains(
        "Design &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; review&#39;s notes"
    ));
    assert!(!body.contains("<script>alert"));
    assert!(!body.contains("provider-secret"));
    assert!(!body.contains("terminal-secret"));
    assert!(!body.contains(&root.path().display().to_string()));
}

#[test]
fn list_omits_explanations_until_index_is_atomically_published() {
    let root = TestDir::new();
    let record = explanation(root.path(), "exp-1", "Still generating");
    fs::create_dir_all(&record.artifact_path).unwrap();
    let source = FakeSource {
        explanations: vec![record],
        ..FakeSource::default()
    };

    let response = handle(Method::GET, "/explanations", &source, root.path());

    assert_eq!(response.status(), Status::OK);
    let body = response.into_body().to_string().unwrap();
    assert!(body.contains("No explanations yet."));
    assert!(!body.contains("/explanations/exp-1"));
}

#[cfg(unix)]
#[test]
fn list_surfaces_artifact_io_errors() {
    use std::os::unix::fs::symlink;

    let root = TestDir::new();
    let record = explanation(root.path(), "exp-1", "Broken artifact");
    fs::create_dir_all(&record.artifact_path).unwrap();
    symlink(
        "index.html",
        Path::new(&record.artifact_path).join("index.html"),
    )
    .unwrap();
    let source = FakeSource {
        explanations: vec![record],
        ..FakeSource::default()
    };

    let response = handle(Method::GET, "/explanations", &source, root.path());

    assert_eq!(response.status(), Status::INTERNAL_SERVER_ERROR);
    assert_eq!(
        response.into_body().to_string().unwrap(),
        "Internal server error"
    );
}

#[test]
fn list_shows_an_empty_state() {
    let root = TestDir::new();
    let response = handle(
        Method::GET,
        "/explanations",
        &FakeSource::default(),
        root.path(),
    );

    assert_eq!(response.status(), Status::OK);
    assert!(response
        .into_body()
        .to_string()
        .unwrap()
        .contains("No explanations yet."));
}

#[test]
fn detail_streams_the_stored_index_html() {
    let root = TestDir::new();
    let record = explanation(root.path(), "exp-1", "Session forks");
    fs::create_dir_all(&record.artifact_path).unwrap();
    fs::write(
        Path::new(&record.artifact_path).join("index.html"),
        "<!doctype html><h1>Session forks</h1>",
    )
    .unwrap();
    let source = FakeSource {
        explanations: vec![record],
        ..FakeSource::default()
    };

    let response = handle(
        Method::GET,
        "/explanations/exp-1",
        &source,
        root.path(),
    );

    assert_eq!(response.status(), Status::OK);
    assert_eq!(header(&response, "content-type"), "text/html; charset=utf-8");
    assert_eq!(header(&response, "cache-control"), "no-store");
    assert_eq!(
        response.into_body().to_string().unwrap(),
        "<!doctype html><h1>Session forks</h1>"
    );
}

#[test]
fn detail_returns_not_found_for_an_unknown_record() {
    let root = TestDir::new();
    let response = handle(
        Method::GET,
        "/explanations/exp-404",
        &FakeSource::default(),
        root.path(),
    );

    assert_eq!(response.status(), Status::NOT_FOUND);
    assert_eq!(response.into_body().to_string().unwrap(), "Not found");
}

#[test]
fn detail_returns_not_found_while_index_is_missing() {
    let root = TestDir::new();
    let record = explanation(root.path(), "exp-1", "Still generating");
    fs::create_dir_all(&record.artifact_path).unwrap();
    let source = FakeSource {
        explanations: vec![record],
        ..FakeSource::default()
    };

    let response = handle(
        Method::GET,
        "/explanations/exp-1",
        &source,
        root.path(),
    );

    assert_eq!(response.status(), Status::NOT_FOUND);
}

#[test]
fn detail_rejects_an_artifact_path_outside_the_explanations_root() {
    let root = TestDir::new();
    let outside = TestDir::new();
    let mut record = explanation(root.path(), "exp-1", "Unsafe path");
    fs::create_dir_all(root.path().join(&record.id)).unwrap();
    fs::create_dir_all(outside.path().join("exp-1")).unwrap();
    fs::write(
        outside.path().join("exp-1/index.html"),
        "sensitive",
    )
    .unwrap();
    record.artifact_path = outside
        .path()
        .join("exp-1")
        .to_string_lossy()
        .into_owned();
    let source = FakeSource {
        explanations: vec![record],
        ..FakeSource::default()
    };

    let response = handle(
        Method::GET,
        "/explanations/exp-1",
        &source,
        root.path(),
    );

    assert_eq!(response.status(), Status::NOT_FOUND);
    assert!(!response.into_body().to_string().unwrap().contains("sensitive"));
}

#[cfg(unix)]
#[test]
fn detail_rejects_an_index_symlink_that_escapes_the_artifact_directory() {
    use std::os::unix::fs::symlink;

    let root = TestDir::new();
    let outside = TestDir::new();
    let record = explanation(root.path(), "exp-1", "Unsafe symlink");
    fs::create_dir_all(&record.artifact_path).unwrap();
    let outside_index = outside.path().join("outside.html");
    fs::write(&outside_index, "sensitive").unwrap();
    symlink(
        outside_index,
        Path::new(&record.artifact_path).join("index.html"),
    )
    .unwrap();
    let source = FakeSource {
        explanations: vec![record],
        ..FakeSource::default()
    };

    let response = handle(
        Method::GET,
        "/explanations/exp-1",
        &source,
        root.path(),
    );

    assert_eq!(response.status(), Status::NOT_FOUND);
}

#[test]
fn malformed_or_nested_detail_paths_do_not_reach_the_source() {
    let root = TestDir::new();
    let source = FakeSource {
        fail_get: true,
        ..FakeSource::default()
    };

    for path in [
        "/explanations/",
        "/explanations/exp-1/index.html",
        "/explanations/bad%2Fid",
    ] {
        let response = handle(Method::GET, path, &source, root.path());
        assert_eq!(response.status(), Status::NOT_FOUND, "path: {path}");
    }
}

#[test]
fn known_routes_reject_non_get_methods() {
    let root = TestDir::new();
    for path in ["/", "/explanations", "/explanations/exp-1"] {
        let response = handle(Method::POST, path, &FakeSource::default(), root.path());
        assert_eq!(response.status(), Status::METHOD_NOT_ALLOWED, "path: {path}");
        assert_eq!(header(&response, "allow"), "GET");
    }
}

#[test]
fn storage_errors_return_a_generic_internal_error() {
    let root = TestDir::new();
    let source = FakeSource {
        fail_list: true,
        fail_get: true,
        ..FakeSource::default()
    };

    for path in ["/explanations", "/explanations/exp-1"] {
        let response = handle(Method::GET, path, &source, root.path());
        assert_eq!(response.status(), Status::INTERNAL_SERVER_ERROR);
        let body = response.into_body().to_string().unwrap();
        assert_eq!(body, "Internal server error");
        assert!(!body.contains("/secret"));
    }
}

#[test]
fn unknown_routes_return_not_found() {
    let root = TestDir::new();
    let response = handle(Method::GET, "/unknown", &FakeSource::default(), root.path());

    assert_eq!(response.status(), Status::NOT_FOUND);
}

#[test]
fn non_loopback_hosts_are_rejected_to_block_dns_rebinding() {
    let root = TestDir::new();
    let request = Request::builder(
        Method::GET,
        "http://attacker.example/explanations".parse().unwrap(),
    )
    .build();

    let response = handle_request_with(
        &request,
        &FakeSource { fail_list: true, ..FakeSource::default() },
        &|| Ok(root.path().to_path_buf()),
    );

    assert_eq!(response.status(), Status::NOT_FOUND);
}
