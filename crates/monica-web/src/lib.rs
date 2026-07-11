use std::net::SocketAddr;
use std::sync::mpsc::SyncSender;

use anyhow::Result;
use axum::extract::{Path, Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::get;
use axum::{Json, Router};
use monica_application::{ApplicationError, ApplicationEvent, EventSink};
use monica_domain::ExplanationId;

pub const PORT_PROD: u16 = 19280;

#[derive(rust_embed::Embed)]
#[folder = "../../dist-web/"]
struct WebAssets;

struct NoopEventSink;

impl EventSink for NoopEventSink {
    fn emit(&self, _event: ApplicationEvent) {}
}

fn open() -> Result<monica_runtime::MonicaFacade> {
    monica_runtime::open_monica(Box::new(NoopEventSink))
}

struct AppError(ApplicationError);

impl From<ApplicationError> for AppError {
    fn from(e: ApplicationError) -> Self {
        Self(e)
    }
}

impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        Self(ApplicationError::from(e))
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        // Validation は現状 id 検証だけが通る経路なので、存在しないリソースと同じ 404 に落とす。
        let status = match &self.0 {
            ApplicationError::NotFound(_) | ApplicationError::Validation(_) => {
                StatusCode::NOT_FOUND
            }
            ApplicationError::Conflict(_) => StatusCode::CONFLICT,
            ApplicationError::AuthenticationRequired(_) => StatusCode::UNAUTHORIZED,
            ApplicationError::Storage(_) | ApplicationError::External(_) => {
                StatusCode::INTERNAL_SERVER_ERROR
            }
        };
        (status, Json(monica_api::ApiError::from(self.0))).into_response()
    }
}

/// rusqlite / std::fs は同期 API なので、runtime スレッドを塞がないよう blocking プールへ逃がす。
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| AppError::from(anyhow::Error::new(e)))?
}

fn check_host(headers: &HeaderMap, port: u16) -> Result<(), StatusCode> {
    let host = headers
        .get("host")
        .and_then(|v| v.to_str().ok())
        .ok_or(StatusCode::FORBIDDEN)?;
    let allowed = [
        format!("127.0.0.1:{port}"),
        format!("localhost:{port}"),
        format!("monica.localhost:{port}"),
    ];
    if !allowed.iter().any(|a| a == host) {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(())
}

async fn require_local_host(
    State(port): State<u16>,
    request: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    check_host(request.headers(), port)?;
    Ok(next.run(request).await)
}

fn content_type(path: &str) -> &'static str {
    match path.rsplit('.').next() {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "application/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("json") => "application/json",
        _ => "application/octet-stream",
    }
}

async fn root() -> Redirect {
    Redirect::to("/explanations")
}

async fn spa_index() -> Response {
    match WebAssets::get("index.html") {
        Some(file) => (
            StatusCode::OK,
            [("content-type", "text/html; charset=utf-8")],
            file.data,
        )
            .into_response(),
        None => (StatusCode::NOT_FOUND, "SPA not built").into_response(),
    }
}

async fn spa_asset(Path(path): Path<String>) -> Response {
    serve_embedded(&format!("assets/{path}"))
}

async fn favicon() -> Response {
    serve_embedded("favicon.png")
}

fn serve_embedded(path: &str) -> Response {
    match WebAssets::get(path) {
        Some(file) => (
            StatusCode::OK,
            [("content-type", content_type(path))],
            file.data,
        )
            .into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn list_explanations() -> Result<Json<Vec<monica_api::ApiExplanation>>, AppError> {
    let list = blocking(|| {
        let mut monica = open()?;
        Ok(monica.explanations().list_explanations()?)
    })
    .await?;
    Ok(Json(list.into_iter().map(Into::into).collect()))
}

async fn get_explanation(
    Path(id): Path<String>,
) -> Result<Json<monica_api::ApiExplanation>, AppError> {
    let explanation = blocking(move || {
        let mut monica = open()?;
        Ok(monica.explanations().get_explanation(&id)?)
    })
    .await?;
    Ok(Json(explanation.into()))
}

async fn delete_explanation(Path(id): Path<String>) -> Result<StatusCode, AppError> {
    blocking(move || {
        let mut monica = open()?;
        Ok(monica.explanations().delete_explanation(&id)?)
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn get_artifact(Path(id): Path<String>) -> Result<Response, AppError> {
    // artifact 配信は facade を経由せず path join するため、ここでの id 検証が traversal 対策の生命線。
    ExplanationId::parse(&id).map_err(ApplicationError::from)?;
    let bytes = blocking(move || {
        let index_path = monica_paths::explanation_index_path(&id)?;
        match std::fs::read(&index_path) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(anyhow::Error::from(e).into()),
        }
    })
    .await?;
    match bytes {
        Some(bytes) => Ok((
            StatusCode::OK,
            [("content-type", "text/html; charset=utf-8")],
            bytes,
        )
            .into_response()),
        None => Err(ApplicationError::not_found("artifact not found").into()),
    }
}

fn build_router(port: u16) -> Router {
    Router::new()
        .route("/", get(root))
        .route("/api/explanations", get(list_explanations))
        .route(
            "/api/explanations/{id}",
            get(get_explanation).delete(delete_explanation),
        )
        .route("/explanations", get(spa_index))
        .route("/explanations/", get(spa_index))
        .route("/explanations/{id}", get(spa_index))
        .route("/explanations/{id}/artifact", get(get_artifact))
        .route("/assets/{*path}", get(spa_asset))
        .route("/favicon.png", get(favicon))
        .layer(middleware::from_fn_with_state(port, require_local_host))
}

pub fn serve(addr: impl Into<SocketAddr>, port_tx: SyncSender<u16>) -> Result<()> {
    let addr = addr.into();

    // fresh / migration 保留中の DB への並列初回 open は SQLITE_BUSY になり得る。受け付け開始前に
    // 一度開いて migration を完了させ、per-request open を no-op チェックに落とす。失敗しても
    // 個々のリクエストがエラーを返せるので、サーバー起動自体は止めない。
    if let Err(e) = open() {
        log::warn!(target: "monica_web", "initial store open failed: {e:#}");
    }

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_io()
        .build()?;

    rt.block_on(async {
        let listener = tokio::net::TcpListener::bind(addr).await?;
        let bound_addr = listener.local_addr()?;
        let _ = port_tx.send(bound_addr.port());
        log::info!(target: "monica_web", "listening on http://{bound_addr}");
        axum::serve(listener, build_router(bound_addr.port())).await?;
        Ok::<(), anyhow::Error>(())
    })?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use monica_application::ports::ExplanationStore;
    use monica_domain::{ExplanationMode, NewExplanation, NewTerminalSession, TerminalSessionKind};
    use tower::ServiceExt;

    // ハンドラは open_monica() 経由で MONICA_HOME 配下の実 DB を開く。セッション環境から
    // 実データの home を継承したままテストすると本物の DB を読み書きしてしまうため、
    // main 前にプロセス専用の temp home へ差し替える。テスト内で set_var しないこと。
    #[ctor::ctor]
    #[allow(clippy::disallowed_methods)] // main 前の単一スレッド区間なので data race がない
    fn isolate_monica_home() {
        let dir = std::env::temp_dir().join(format!("monica-test-home-{}", std::process::id()));
        std::env::set_var("MONICA_HOME", dir);
    }

    // 並列テストが fresh DB の初回 open（= migration）を同時に走らせると SQLITE_BUSY で落ちる。
    // OnceLock は closure が panic しても poison しない（Once と違い後続が再試行できる）。
    fn migrated() {
        static MIGRATED: std::sync::OnceLock<()> = std::sync::OnceLock::new();
        MIGRATED.get_or_init(|| {
            open().expect("initial store open must succeed");
        });
    }

    fn app() -> Router {
        migrated();
        build_router(19999)
    }

    fn seed_explanation(title: &str) -> String {
        migrated();
        let mut store = monica_storage_sqlite::SqliteStore::open().unwrap();
        let session = store
            .create_terminal_session(NewTerminalSession {
                runspace_id: None,
                tab_id: None,
                kind: TerminalSessionKind::Shell,
                cwd: "/tmp".to_string(),
                shell: "/bin/zsh".to_string(),
                rows: 24,
                cols: 80,
            })
            .unwrap();
        let explanation = store
            .insert_explanation(NewExplanation {
                title: title.to_string(),
                mode: ExplanationMode::Diff,
                provider_session_id: "p1".to_string(),
                terminal_session_id: session.id,
            })
            .unwrap();
        explanation.id.into_string()
    }

    fn get_req(uri: &str) -> Request<Body> {
        Request::builder()
            .uri(uri)
            .header("host", "127.0.0.1:19999")
            .body(Body::empty())
            .unwrap()
    }

    fn delete_req(uri: &str) -> Request<Body> {
        Request::builder()
            .method("DELETE")
            .uri(uri)
            .header("host", "127.0.0.1:19999")
            .body(Body::empty())
            .unwrap()
    }

    async fn body_string(response: Response) -> String {
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        String::from_utf8(bytes.to_vec()).unwrap()
    }

    #[tokio::test]
    async fn root_redirects_to_explanations() {
        let response = app().oneshot(get_req("/")).await.unwrap();
        assert_eq!(response.status(), StatusCode::SEE_OTHER);
        assert_eq!(
            response.headers().get("location").unwrap().to_str().unwrap(),
            "/explanations"
        );
    }

    #[tokio::test]
    async fn spa_explanations_returns_html() {
        let response = app().oneshot(get_req("/explanations")).await.unwrap();
        let status = response.status();
        if WebAssets::get("index.html").is_some() {
            assert_eq!(status, StatusCode::OK);
            let ct = response
                .headers()
                .get("content-type")
                .unwrap()
                .to_str()
                .unwrap();
            assert!(ct.contains("text/html"), "content-type was: {ct}");
        } else {
            assert_eq!(status, StatusCode::NOT_FOUND);
        }
    }

    #[tokio::test]
    async fn spa_detail_returns_html() {
        let response = app()
            .oneshot(get_req("/explanations/expl-1"))
            .await
            .unwrap();
        let status = response.status();
        if WebAssets::get("index.html").is_some() {
            assert_eq!(status, StatusCode::OK);
        } else {
            assert_eq!(status, StatusCode::NOT_FOUND);
        }
    }

    #[tokio::test]
    async fn unknown_asset_returns_404() {
        let response = app()
            .oneshot(get_req("/assets/nonexistent.js"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn unknown_path_returns_404() {
        let response = app().oneshot(get_req("/nonexistent")).await.unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn invalid_explanation_id_returns_404() {
        let response = app()
            .oneshot(get_req("/api/explanations/..%2Fevil"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn expl_zero_returns_404() {
        let response = app()
            .oneshot(get_req("/api/explanations/expl-0"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn host_header_rejection() {
        let response = app()
            .oneshot(
                Request::builder()
                    .uri("/api/explanations")
                    .header("host", "evil.example.com:19999")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn missing_host_header_rejected() {
        let response = app()
            .oneshot(
                Request::builder()
                    .uri("/api/explanations")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn valid_host_header_accepted() {
        let response = app().oneshot(get_req("/api/explanations")).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = body_string(response).await;
        let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert!(parsed.is_array(), "expected JSON array, got: {body}");
    }

    #[tokio::test]
    async fn localhost_host_header_accepted() {
        let response = app()
            .oneshot(
                Request::builder()
                    .uri("/api/explanations")
                    .header("host", "localhost:19999")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn monica_localhost_host_header_accepted() {
        let response = app()
            .oneshot(
                Request::builder()
                    .uri("/api/explanations")
                    .header("host", "monica.localhost:19999")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn get_delete_artifact_success_paths() {
        let id = seed_explanation("Success Path");
        let index_path = monica_paths::explanation_index_path(&id).unwrap();
        std::fs::create_dir_all(index_path.parent().unwrap()).unwrap();
        std::fs::write(&index_path, "<h1>hello artifact</h1>").unwrap();

        let response = app()
            .oneshot(get_req(&format!("/api/explanations/{id}")))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = body_string(response).await;
        let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(parsed["id"], id.as_str());
        assert_eq!(parsed["title"], "Success Path");
        assert_eq!(parsed["mode"], "diff");

        let response = app()
            .oneshot(get_req(&format!("/explanations/{id}/artifact")))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_string();
        assert_eq!(content_type, "text/html; charset=utf-8");
        let body = body_string(response).await;
        assert!(body.contains("hello artifact"), "body was: {body}");

        let response = app()
            .oneshot(delete_req(&format!("/api/explanations/{id}")))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert!(!index_path.exists(), "artifact dir should be removed");

        let response = app()
            .oneshot(delete_req(&format!("/api/explanations/{id}")))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);

        let response = app()
            .oneshot(get_req(&format!("/explanations/{id}/artifact")))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn artifact_missing_file_returns_404() {
        let id = seed_explanation("No Artifact");
        let response = app()
            .oneshot(get_req(&format!("/explanations/{id}/artifact")))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn serve_binds_and_reports_port() {
        migrated();
        let (port_tx, port_rx) = std::sync::mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let _ = serve(([127, 0, 0, 1], 0u16), port_tx);
        });
        let port = port_rx
            .recv_timeout(std::time::Duration::from_secs(10))
            .expect("serve should report its bound port");

        use std::io::{Read, Write};
        let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        let request =
            format!("GET / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
        stream.write_all(request.as_bytes()).unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        assert!(response.contains("303"), "response: {response}");
        assert!(
            response.contains("/explanations"),
            "response: {response}"
        );
    }

    #[test]
    fn export_web_types() {
        let types = specta::Types::default()
            .register::<monica_api::ApiExplanation>()
            .register::<monica_api::ApiExplanationMode>();
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../web/src/types.gen.ts");
        specta_typescript::Typescript::default()
            .header("// This file is auto-generated by specta-typescript. Do not edit manually.\n// Regenerate with: cargo test -p monica-web --lib tests::export_web_types -- --exact\n")
            .export_to(&path, &types, specta_serde::Format)
            .expect("failed to export web types");
    }
}
