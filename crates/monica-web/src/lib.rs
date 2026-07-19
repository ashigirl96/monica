use std::future::IntoFuture;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::mpsc::SyncSender;
use std::sync::Arc;

use anyhow::Result;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, Query, Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use monica_application::{ApplicationError, ApplicationEvent, EventSink};
use monica_domain::{ExplanationId, SyncedBlockMode};

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

/// check_host が照合する到達可能ホストの集合。middleware state として routers 間で共有する。
/// Host ヘッダはクライアント制御なのでこれは認証ではなく DNS リバインディング対策であり、
/// 実際の到達制御は bind するインターフェース（loopback + Tailscale IP）側で行う。
#[derive(Clone)]
struct AllowedHosts(Arc<Vec<String>>);

fn allowed_hosts(port: u16, tailscale_ip: Option<Ipv4Addr>) -> AllowedHosts {
    let mut hosts = vec![
        format!("127.0.0.1:{port}"),
        format!("localhost:{port}"),
        format!("monica.localhost:{port}"),
    ];
    // Tailscale 越しのスマホアクセスは IP 直指定（http://100.x.y.z:port）で行う。
    // ワイルドカードや .ts.net サフィックス一致は使わず、割当 IP の完全一致だけを足す。
    if let Some(ip) = tailscale_ip {
        hosts.push(format!("{ip}:{port}"));
    }
    AllowedHosts(Arc::new(hosts))
}

fn check_host(headers: &HeaderMap, allowed: &[String]) -> Result<(), StatusCode> {
    let host = headers
        .get("host")
        .and_then(|v| v.to_str().ok())
        .ok_or(StatusCode::FORBIDDEN)?;
    if !allowed.iter().any(|a| a == host) {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(())
}

async fn require_local_host(
    State(allowed): State<AllowedHosts>,
    request: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    check_host(request.headers(), &allowed.0)?;
    Ok(next.run(request).await)
}

/// Tailscale が割り当てる CGNAT アドレス（100.64.0.0/10）か判定する。
fn is_tailscale_cgnat(ip: Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    a == 100 && (64..=127).contains(&b)
}

/// `tailscale` CLI の探索パス。GUI 起動時の PATH は /usr/bin:/bin:/usr/sbin:/sbin に絞られ
/// /usr/local/bin を含まないため、素の名前だけでなく実体パスも明示的に試す。
const TAILSCALE_BINS: [&str; 4] = [
    "tailscale",
    "/usr/local/bin/tailscale",
    "/opt/homebrew/bin/tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];

/// Tailscale が実際に割り当てた IPv4 を返す。`tailscale ip -4` を Tailscale 本体に問い合わせる
/// ため、停止中はコマンドが失敗し None になる。100.64.0.0/10 の見た目一致で推測すると、同レンジ
/// を実 LAN に使う公衆 Wi-Fi 等を Tailscale と誤検出して認証なしで晒すため、情報源は Tailscale
/// 自身に限る。返り値も CGNAT 範囲で検証し、範囲外の IP には bind しない安全弁を残す。
fn tailscale_ipv4() -> Option<Ipv4Addr> {
    for bin in TAILSCALE_BINS {
        let Ok(output) = std::process::Command::new(bin).args(["ip", "-4"]).output() else {
            continue;
        };
        if !output.status.success() {
            continue;
        }
        if let Some(ip) = String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| line.trim().parse::<Ipv4Addr>().ok())
            .find(|ip| is_tailscale_cgnat(*ip))
        {
            return Some(ip);
        }
    }
    None
}

/// `tailscale_ipv4` を短時間ポーリングする。ログイン時自動起動では tailscaled のインターフェース
/// 準備が Monica 起動に間に合わず初回検出が空振りしうるため、一定回数まで待って再試行する。
/// 最後まで検出できなければ None（loopback のみ）に倒す。
///
/// プローブ（tailscale CLI 実行）はデーモンや Network Extension が wedged だとハングしうる。
/// 同期ブロッキングのまま呼ぶと、単一スレッドランタイム上で同居する loopback serve ごと止まり
/// 既報告のローカル URL が固まるため、spawn_blocking でランタイムスレッド外へ逃がし、全体を
/// timeout で打ち切る。ハングしても掴まれ続ける blocking スレッドは最大 1 本に留める。
async fn tailscale_ipv4_wait() -> Option<Ipv4Addr> {
    const OVERALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(45);
    let probe = tokio::task::spawn_blocking(|| {
        const ATTEMPTS: u32 = 15;
        const INTERVAL: std::time::Duration = std::time::Duration::from_secs(2);
        for attempt in 0..ATTEMPTS {
            if let Some(ip) = tailscale_ipv4() {
                return Some(ip);
            }
            if attempt + 1 < ATTEMPTS {
                std::thread::sleep(INTERVAL);
            }
        }
        None
    });
    match tokio::time::timeout(OVERALL_TIMEOUT, probe).await {
        Ok(Ok(ip)) => ip,
        _ => None,
    }
}

fn content_type(path: &str) -> &'static str {
    match path.rsplit('.').next() {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "application/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
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

#[derive(serde::Deserialize)]
struct DateRangeQuery {
    from: Option<String>,
    to: Option<String>,
}

fn load_notes_settings() -> Result<monica_settings::NotesSettings, AppError> {
    let base = monica_paths::base_dir()?;
    Ok(monica_settings::Settings::load_from(&base)?.notes)
}

async fn create_note() -> Result<(StatusCode, Json<monica_api::ApiNote>), AppError> {
    let note = blocking(|| {
        let settings = load_notes_settings()?;
        let mut monica = open()?;
        Ok(monica.notes().create_note(settings.day_boundary_hour)?)
    })
    .await?;
    Ok((StatusCode::CREATED, Json(note.into())))
}

async fn set_note_kind(
    Path(id): Path<String>,
    Json(body): Json<monica_api::ApiSetNoteKind>,
) -> Result<Json<monica_api::ApiNote>, AppError> {
    let note = blocking(move || {
        let mut monica = open()?;
        Ok(monica.notes().set_note_kind(&id, body.into())?)
    })
    .await?;
    Ok(Json(note.into()))
}

async fn notes_today() -> Result<Json<monica_api::ApiNotesToday>, AppError> {
    let date = blocking(|| {
        let settings = load_notes_settings()?;
        let mut monica = open()?;
        Ok(monica.notes().logical_today(settings.day_boundary_hour)?)
    })
    .await?;
    Ok(Json(monica_api::ApiNotesToday { date }))
}

async fn get_notes_settings() -> Result<Json<monica_api::NotesSettings>, AppError> {
    let settings = blocking(load_notes_settings).await?;
    Ok(Json(settings.into()))
}

async fn put_notes_settings(
    Json(body): Json<monica_api::NotesSettings>,
) -> Result<Response, AppError> {
    let incoming: monica_settings::NotesSettings = body.into();
    // ApplicationError::Validation は 404 に写像されるので、入力エラーはここで 422 に落とす。
    if incoming.validate().is_err() {
        return Ok(StatusCode::UNPROCESSABLE_ENTITY.into_response());
    }
    let saved = blocking(move || {
        let base = monica_paths::base_dir()?;
        // read-modify-write: translate など他セクションを保存で消さない
        let mut settings = monica_settings::Settings::load_from(&base)?;
        settings.notes = incoming;
        settings.save_to(&base)?;
        Ok(settings.notes)
    })
    .await?;
    Ok(Json(monica_api::NotesSettings::from(saved)).into_response())
}

async fn list_notes(
    Query(range): Query<DateRangeQuery>,
) -> Result<Json<Vec<monica_api::ApiNoteSummary>>, AppError> {
    let list = blocking(move || {
        let mut monica = open()?;
        Ok(monica.notes().list_notes(range.from.as_deref(), range.to.as_deref())?)
    })
    .await?;
    Ok(Json(list.into_iter().map(Into::into).collect()))
}

#[derive(serde::Deserialize)]
struct ProjectNotesQuery {
    project_id: String,
    #[serde(default)]
    offset: usize,
}

async fn list_project_notes(
    Query(query): Query<ProjectNotesQuery>,
) -> Result<Json<monica_api::ApiNotePage>, AppError> {
    let page = blocking(move || {
        let mut monica = open()?;
        Ok(monica.notes().list_project_notes(&query.project_id, query.offset)?)
    })
    .await?;
    Ok(Json(page.into()))
}

#[derive(serde::Deserialize)]
struct GetNoteQuery {
    #[serde(default)]
    format: Option<String>,
    #[serde(default)]
    expand: Option<String>,
}

async fn get_note(
    Path(id): Path<String>,
    Query(query): Query<GetNoteQuery>,
) -> Result<Response, AppError> {
    match query.format.as_deref() {
        // 既定は従来どおり ProseMirror doc JSON（フロントの正の取得経路）。
        None => {
            let note = blocking(move || {
                let mut monica = open()?;
                Ok(monica.notes().get_note(&id)?)
            })
            .await?;
            Ok(Json(monica_api::ApiNote::from(note)).into_response())
        }
        // markdown 投影（agent / 人が読む用）。真実は content JSON のまま。
        Some("markdown") | Some("md") => {
            let mode = match query.expand.as_deref() {
                None => SyncedBlockMode::Reference,
                Some("synced") => SyncedBlockMode::Expand,
                // Validation は 404 に写像されるので、入力エラーはここで 422 に落とす。
                Some(_) => return Ok(StatusCode::UNPROCESSABLE_ENTITY.into_response()),
            };
            let markdown = blocking(move || {
                let mut monica = open()?;
                Ok(monica.notes().note_markdown(&id, mode)?)
            })
            .await?;
            Ok((
                [(axum::http::header::CONTENT_TYPE, "text/markdown; charset=utf-8")],
                markdown,
            )
                .into_response())
        }
        Some(_) => Ok(StatusCode::UNPROCESSABLE_ENTITY.into_response()),
    }
}

async fn update_note(
    Path(id): Path<String>,
    Json(body): Json<monica_api::ApiUpdateNote>,
) -> Result<StatusCode, AppError> {
    // autosave が毎秒叩く経路。クライアントはレスポンス body を読まないので、
    // 全文 doc をパースし直して返送するコストを掛けずに 204 で応える。
    blocking(move || {
        let mut monica = open()?;
        monica.notes().update_note(&id, body.into())?;
        Ok(())
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_note(Path(id): Path<String>) -> Result<StatusCode, AppError> {
    blocking(move || {
        let mut monica = open()?;
        Ok(monica.notes().delete_note(&id)?)
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn restore_note(Path(id): Path<String>) -> Result<Json<monica_api::ApiNote>, AppError> {
    let note = blocking(move || {
        let mut monica = open()?;
        Ok(monica.notes().restore_note(&id)?)
    })
    .await?;
    Ok(Json(note.into()))
}

async fn daily_note_counts(
    Query(range): Query<DateRangeQuery>,
) -> Result<Json<Vec<monica_api::ApiDailyNoteCount>>, AppError> {
    let counts = blocking(move || {
        let mut monica = open()?;
        Ok(monica.notes().daily_counts(range.from.as_deref(), range.to.as_deref())?)
    })
    .await?;
    Ok(Json(counts.into_iter().map(Into::into).collect()))
}

#[derive(serde::Deserialize)]
struct MentionSearchQuery {
    #[serde(default)]
    q: String,
}

async fn search_note_mentions(
    Query(query): Query<MentionSearchQuery>,
) -> Result<Json<Vec<monica_api::ApiNoteMention>>, AppError> {
    let list = blocking(move || {
        let mut monica = open()?;
        Ok(monica.notes().search_note_mentions(&query.q)?)
    })
    .await?;
    Ok(Json(list.into_iter().map(Into::into).collect()))
}

async fn resolve_note_mention(
    Path(id): Path<String>,
) -> Result<Json<monica_api::ApiNoteMention>, AppError> {
    let note = blocking(move || {
        let mut monica = open()?;
        Ok(monica.notes().get_note(&id)?)
    })
    .await?;
    Ok(Json(note.into()))
}

async fn get_note_block(
    Path((id, block_id)): Path<(String, String)>,
) -> Result<Json<monica_api::ApiNoteBlock>, AppError> {
    let block = blocking(move || {
        let mut monica = open()?;
        Ok(monica.notes().get_note_block(&id, &block_id)?)
    })
    .await?;
    Ok(Json(block.into()))
}

async fn list_projects() -> Result<Json<Vec<monica_api::ProjectOption>>, AppError> {
    let list = blocking(|| {
        let mut monica = open()?;
        Ok(monica.projects().list_projects()?)
    })
    .await?;
    Ok(Json(list.into_iter().map(Into::into).collect()))
}

#[derive(serde::Deserialize)]
struct OgpQuery {
    url: String,
}

async fn get_ogp(
    Query(query): Query<OgpQuery>,
) -> Result<Json<monica_api::ApiLinkPreview>, StatusCode> {
    // URL 検証（scheme ガード含む）は adapters 側が正。ここは HTTP status への写像だけ。
    let preview = monica_runtime::fetch_link_preview(&query.url).await.map_err(|e| match e {
        monica_runtime::LinkPreviewError::InvalidUrl(_) => StatusCode::BAD_REQUEST,
        monica_runtime::LinkPreviewError::Fetch(_) => StatusCode::BAD_GATEWAY,
    })?;
    Ok(Json(preview.into()))
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

// Content-Type ヘッダは信用せず、adapters が magic bytes で判定する。ここは HTTP status への写像だけ。
fn asset_status(e: monica_runtime::AssetError) -> StatusCode {
    match e {
        monica_runtime::AssetError::InvalidUrl(_) => StatusCode::BAD_REQUEST,
        monica_runtime::AssetError::Fetch(_) => StatusCode::BAD_GATEWAY,
        monica_runtime::AssetError::UnsupportedFormat => StatusCode::UNSUPPORTED_MEDIA_TYPE,
        monica_runtime::AssetError::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
        monica_runtime::AssetError::Io(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

fn created_asset(saved: monica_runtime::SavedAsset) -> Response {
    (StatusCode::CREATED, Json(monica_api::ApiAsset { id: saved.id, url: saved.url })).into_response()
}

async fn upload_asset(body: Bytes) -> Result<Response, StatusCode> {
    let saved = tokio::task::spawn_blocking(move || monica_runtime::save_asset(&body))
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .map_err(asset_status)?;
    Ok(created_asset(saved))
}

async fn get_asset(Path(id): Path<String>) -> Result<Response, StatusCode> {
    // id 検証（traversal 対策）は adapters の parse_asset_id が正。malformed / 不在はどちらも 404。
    let asset = tokio::task::spawn_blocking(move || monica_runtime::read_asset(&id))
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .map_err(asset_status)?;
    match asset {
        Some((bytes, content_type)) => Ok((
            StatusCode::OK,
            [
                ("content-type", content_type),
                // 内容は uuid ごとに不変なので永続キャッシュ可
                ("cache-control", "public, max-age=31536000, immutable"),
            ],
            bytes,
        )
            .into_response()),
        None => Err(StatusCode::NOT_FOUND),
    }
}

async fn import_asset(
    Json(req): Json<monica_api::ApiImportAsset>,
) -> Result<Response, StatusCode> {
    let saved = monica_runtime::import_asset(&req.url).await.map_err(asset_status)?;
    Ok(created_asset(saved))
}

fn build_router(allowed: AllowedHosts) -> Router {
    Router::new()
        .route("/", get(root))
        .route("/api/explanations", get(list_explanations))
        .route(
            "/api/explanations/{id}",
            get(get_explanation).delete(delete_explanation),
        )
        .route("/api/notes", get(list_notes).post(create_note))
        .route("/api/notes/by-project", get(list_project_notes))
        .route("/api/notes/daily-counts", get(daily_note_counts))
        .route("/api/notes/mentions", get(search_note_mentions))
        .route("/api/notes/mentions/{id}", get(resolve_note_mention))
        .route("/api/notes/today", get(notes_today))
        .route(
            "/api/notes/{id}",
            get(get_note).put(update_note).delete(delete_note),
        )
        .route("/api/notes/{id}/kind", post(set_note_kind))
        .route("/api/notes/{id}/restore", post(restore_note))
        .route("/api/notes/{id}/blocks/{block_id}", get(get_note_block))
        .route("/api/ogp", get(get_ogp))
        .route(
            "/api/assets",
            post(upload_asset).layer(DefaultBodyLimit::max(monica_runtime::MAX_ASSET_BYTES)),
        )
        .route("/api/assets/import", post(import_asset))
        .route("/api/assets/{id}", get(get_asset))
        .route("/api/projects", get(list_projects))
        .route("/api/settings/notes", get(get_notes_settings).put(put_notes_settings))
        .route("/explanations", get(spa_index))
        .route("/explanations/", get(spa_index))
        .route("/explanations/{id}", get(spa_index))
        .route("/explanations/{id}/artifact", get(get_artifact))
        .route("/notes", get(spa_index))
        .route("/notes/", get(spa_index))
        .route("/notes/{id}", get(spa_index))
        .route("/settings", get(spa_index))
        .route("/assets/{*path}", get(spa_asset))
        .route("/favicon.png", get(favicon))
        .layer(middleware::from_fn_with_state(allowed, require_local_host))
}

pub fn serve(addr: impl Into<SocketAddr>, port_tx: SyncSender<u16>) -> Result<()> {
    let addr = addr.into();

    // fresh / migration 保留中の DB への並列初回 open は SQLITE_BUSY になり得る。受け付け開始前に
    // 一度開いて migration を完了させ、per-request open を no-op チェックに落とす。失敗しても
    // 個々のリクエストがエラーを返せるので、サーバー起動自体は止めない。
    if let Err(e) = open() {
        log::warn!(target: "monica_web", "initial store open failed: {e:#}");
    }

    // enable_time は reqwest の timeout（OGP 取得）が time driver を要求するため
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_io()
        .enable_time()
        .build()?;

    rt.block_on(async {
        let listener = tokio::net::TcpListener::bind(addr).await?;
        let bound_addr = listener.local_addr()?;
        let port = bound_addr.port();
        let _ = port_tx.send(port);
        log::info!(target: "monica_web", "listening on http://{bound_addr}");

        // loopback は Tailscale 検出を待たせず即座に serve する。tailnet 向けの追加 bind は
        // 別タスクで後追いするため、検出が遅れても・失敗しても loopback アクセスは無影響。
        let loopback = tokio::spawn(
            axum::serve(listener, build_router(allowed_hosts(port, None))).into_future(),
        );

        // Monica が起動している間は Tailscale インターフェースの IP に「限定して」追加 bind し、
        // tailnet 内の自分の端末（スマホ等）から到達できるようにする。0.0.0.0 は使わない（全 NIC
        // 露出 = 認証なしで公衆 Wi-Fi にも晒す）。ログイン項目としての自動起動直後は tailscaled が
        // まだ IP を割り当てておらず一度きりの検出だと取りこぼすため、短時間リトライしてから諦める。
        if let Some(ip) = tailscale_ipv4_wait().await {
            match tokio::net::TcpListener::bind(SocketAddr::from((ip, port))).await {
                Ok(ts) => {
                    log::info!(target: "monica_web", "also listening on http://{ip}:{port} (tailscale)");
                    tokio::spawn(
                        axum::serve(ts, build_router(allowed_hosts(port, Some(ip)))).into_future(),
                    );
                }
                Err(e) => {
                    log::warn!(target: "monica_web", "tailscale bind {ip}:{port} failed: {e:#}");
                }
            }
        }

        loopback.await??;
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
    use monica_application::ProjectRepository;
    use monica_domain::{ExplanationMode, NewExplanation, NewTerminalSession, TerminalSessionKind};
    use tower::ServiceExt;

    // ハンドラは open_monica() 経由で MONICA_HOME 配下の実 DB を開く。セッション環境から
    // 実データの home を継承したままテストすると本物の DB を読み書きしてしまうため、
    // main 前にプロセス専用の temp home へ差し替える。テスト内で set_var しないこと。
    #[ctor::ctor(unsafe)]
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
        build_router(allowed_hosts(19999, None))
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
                summary: Some(format!("{title} summary")),
                mode: ExplanationMode::Diff,
                provider_session_id: "p1".to_string(),
                terminal_session_id: session.id,
                repo_name: None,
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

    fn post_req(uri: &str) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri(uri)
            .header("host", "127.0.0.1:19999")
            .body(Body::empty())
            .unwrap()
    }

    fn put_json_req(uri: &str, body: &serde_json::Value) -> Request<Body> {
        Request::builder()
            .method("PUT")
            .uri(uri)
            .header("host", "127.0.0.1:19999")
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
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

    #[test]
    fn tailscale_cgnat_range_boundaries() {
        assert!(is_tailscale_cgnat(Ipv4Addr::new(100, 64, 0, 0)));
        assert!(is_tailscale_cgnat(Ipv4Addr::new(100, 100, 100, 100)));
        assert!(is_tailscale_cgnat(Ipv4Addr::new(100, 127, 255, 255)));
        assert!(!is_tailscale_cgnat(Ipv4Addr::new(100, 63, 255, 255)));
        assert!(!is_tailscale_cgnat(Ipv4Addr::new(100, 128, 0, 0)));
        assert!(!is_tailscale_cgnat(Ipv4Addr::new(192, 168, 1, 2)));
        assert!(!is_tailscale_cgnat(Ipv4Addr::new(10, 0, 0, 1)));
    }

    #[tokio::test]
    async fn tailscale_host_header_accepted_only_when_bound() {
        migrated();
        let ip = Ipv4Addr::new(100, 100, 42, 7);
        let with_ts = build_router(allowed_hosts(19999, Some(ip)));
        let response = with_ts
            .oneshot(
                Request::builder()
                    .uri("/api/explanations")
                    .header("host", format!("{ip}:19999"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        // Tailscale bind していない router では同じ Host は許可しない。
        let response = app()
            .oneshot(
                Request::builder()
                    .uri("/api/explanations")
                    .header("host", format!("{ip}:19999"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
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

    async fn create_note_via_api() -> serde_json::Value {
        let response = app().oneshot(post_req("/api/notes")).await.unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        serde_json::from_str(&body_string(response).await).unwrap()
    }

    async fn post_json_req(uri: &str, body: &serde_json::Value) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri(uri)
            .header("host", "127.0.0.1:19999")
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    async fn set_kind(id: &str, body: serde_json::Value) -> Response {
        app()
            .oneshot(post_json_req(&format!("/api/notes/{id}/kind"), &body).await)
            .await
            .unwrap()
    }

    async fn fetch_note(id: &str) -> serde_json::Value {
        let response = app().oneshot(get_req(&format!("/api/notes/{id}"))).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        serde_json::from_str(&body_string(response).await).unwrap()
    }

    #[tokio::test]
    async fn post_create_note_returns_daily_defaults() {
        let created = create_note_via_api().await;
        assert!(created["id"].as_str().unwrap().starts_with("note-"));
        assert_eq!(created["kind"], serde_json::json!({"kind": "daily"}));
        assert!(created.get("title").is_none(), "title は kind payload に吸収済み");
        assert!(created.get("project_id").is_none());
        assert_eq!(created["content"]["type"], "doc");
        let date = created["date"].as_str().unwrap();
        assert_eq!(date.len(), 10, "date must be YYYY-MM-DD, got {date}");
    }

    #[tokio::test]
    async fn put_updates_content_but_cannot_change_kind() {
        let created = create_note_via_api().await;
        let id = created["id"].as_str().unwrap();

        // 旧 payload の kind / project_id を混ぜても無視され、daily の title も付かない
        let body = serde_json::json!({
            "title": "ignored on daily",
            "kind": {"kind": "essay", "title": "smuggled"},
            "project_id": "o/smuggled",
            "content": {"type": "doc", "content": []},
        });
        let response = app()
            .oneshot(put_json_req(&format!("/api/notes/{id}"), &body))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);

        let fetched = fetch_note(id).await;
        assert_eq!(fetched["kind"], serde_json::json!({"kind": "daily"}));
        assert_eq!(fetched["date"], created["date"]);
    }

    async fn put_content(id: &str, content: serde_json::Value) {
        let body = serde_json::json!({ "content": content });
        let response =
            app().oneshot(put_json_req(&format!("/api/notes/{id}"), &body)).await.unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
    }

    fn doc(text: &str) -> serde_json::Value {
        serde_json::json!({
            "type": "doc",
            "content": [{ "type": "blockGroup", "content": [{ "type": "blockContainer",
                "content": [{ "type": "heading", "attrs": { "level": 2 },
                    "content": [{ "type": "text", "text": text }] }] }] }]
        })
    }

    #[tokio::test]
    async fn get_note_markdown_returns_text_markdown() {
        let created = create_note_via_api().await;
        let id = created["id"].as_str().unwrap().to_string();
        put_content(&id, doc("Hello")).await;

        let response =
            app().oneshot(get_req(&format!("/api/notes/{id}?format=markdown"))).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let ct = response.headers().get("content-type").unwrap().to_str().unwrap().to_string();
        assert!(ct.starts_with("text/markdown"), "content-type: {ct}");
        assert_eq!(body_string(response).await, "## Hello");
    }

    #[tokio::test]
    async fn get_note_without_format_is_still_json() {
        let created = create_note_via_api().await;
        let id = created["id"].as_str().unwrap();
        let fetched = fetch_note(id).await;
        assert_eq!(fetched["id"], created["id"], "format 省略時は従来の JSON");
    }

    #[tokio::test]
    async fn get_note_rejects_unknown_format_and_expand() {
        let created = create_note_via_api().await;
        let id = created["id"].as_str().unwrap();

        for uri in [
            format!("/api/notes/{id}?format=bogus"),
            format!("/api/notes/{id}?format=markdown&expand=bogus"),
        ] {
            let response = app().oneshot(get_req(&uri)).await.unwrap();
            assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY, "{uri}");
        }
    }

    #[tokio::test]
    async fn get_note_markdown_missing_id_is_404() {
        let response =
            app().oneshot(get_req("/api/notes/note-999999?format=markdown")).await.unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn kind_transitions_daily_essay_round_trip() {
        let created = create_note_via_api().await;
        let id = created["id"].as_str().unwrap();

        // daily → essay は空 title で生まれる
        let response = set_kind(id, serde_json::json!({"kind": "essay"})).await;
        assert_eq!(response.status(), StatusCode::OK);
        let essay: serde_json::Value = serde_json::from_str(&body_string(response).await).unwrap();
        assert_eq!(essay["kind"], serde_json::json!({"kind": "essay", "title": ""}));

        // essay の title は PUT で編集できる
        let body = serde_json::json!({
            "title": "morning pages",
            "content": {"type": "doc", "content": []},
        });
        let response = app()
            .oneshot(put_json_req(&format!("/api/notes/{id}"), &body))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        let fetched = fetch_note(id).await;
        assert_eq!(fetched["kind"], serde_json::json!({"kind": "essay", "title": "morning pages"}));

        // essay → daily は title を破棄する
        let response = set_kind(id, serde_json::json!({"kind": "daily"})).await;
        assert_eq!(response.status(), StatusCode::OK);
        let fetched = fetch_note(id).await;
        assert_eq!(fetched["kind"], serde_json::json!({"kind": "daily"}));
    }

    #[tokio::test]
    async fn kind_promotion_to_project_is_terminal() {
        migrated();
        let store = monica_storage_sqlite::SqliteStore::open().unwrap();
        store
            .upsert_project(
                &monica_domain::Project::from_repo("webtest/promotion"),
                &monica_application::ExecutionProfile::default(),
            )
            .unwrap();

        let created = create_note_via_api().await;
        let id = created["id"].as_str().unwrap();

        let response =
            set_kind(id, serde_json::json!({"kind": "project", "project_id": "webtest/promotion"}))
                .await;
        assert_eq!(response.status(), StatusCode::OK);
        let promoted: serde_json::Value =
            serde_json::from_str(&body_string(response).await).unwrap();
        assert_eq!(
            promoted["kind"],
            serde_json::json!({"kind": "project", "project_id": "webtest/promotion"})
        );

        // project からの脱出経路なし
        for target in [
            serde_json::json!({"kind": "daily"}),
            serde_json::json!({"kind": "essay"}),
            serde_json::json!({"kind": "project", "project_id": "webtest/promotion"}),
        ] {
            let response = set_kind(id, target.clone()).await;
            assert_eq!(response.status(), StatusCode::CONFLICT, "target: {target}");
        }
    }

    #[tokio::test]
    async fn kind_transition_rejects_essay_to_project_and_bad_input() {
        migrated();
        let store = monica_storage_sqlite::SqliteStore::open().unwrap();
        store
            .upsert_project(
                &monica_domain::Project::from_repo("webtest/no-direct"),
                &monica_application::ExecutionProfile::default(),
            )
            .unwrap();

        let created = create_note_via_api().await;
        let id = created["id"].as_str().unwrap();
        let response = set_kind(id, serde_json::json!({"kind": "essay"})).await;
        assert_eq!(response.status(), StatusCode::OK);

        // essay → project 直行なし
        let response =
            set_kind(id, serde_json::json!({"kind": "project", "project_id": "webtest/no-direct"}))
                .await;
        assert_eq!(response.status(), StatusCode::CONFLICT);

        // 未知の project は 404、不正 body は 422
        let daily = create_note_via_api().await;
        let daily_id = daily["id"].as_str().unwrap();
        let response =
            set_kind(daily_id, serde_json::json!({"kind": "project", "project_id": "o/missing"}))
                .await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let response = set_kind(daily_id, serde_json::json!({"kind": "diary"})).await;
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let response = set_kind("note-999999", serde_json::json!({"kind": "essay"})).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn notes_today_returns_a_date() {
        let response = app().oneshot(get_req("/api/notes/today")).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let today: serde_json::Value = serde_json::from_str(&body_string(response).await).unwrap();
        let date = today["date"].as_str().unwrap();
        assert_eq!(date.len(), 10, "date must be YYYY-MM-DD, got {date}");
    }

    #[tokio::test]
    async fn notes_settings_round_trip_and_validation() {
        migrated();
        let response = app().oneshot(get_req("/api/settings/notes")).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let settings: serde_json::Value =
            serde_json::from_str(&body_string(response).await).unwrap();
        assert!(settings["day_boundary_hour"].as_u64().unwrap() <= 23);

        let response = app()
            .oneshot(put_json_req(
                "/api/settings/notes",
                &serde_json::json!({"day_boundary_hour": 5}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let saved: serde_json::Value = serde_json::from_str(&body_string(response).await).unwrap();
        assert_eq!(saved["day_boundary_hour"], 5);

        let response = app().oneshot(get_req("/api/settings/notes")).await.unwrap();
        let settings: serde_json::Value =
            serde_json::from_str(&body_string(response).await).unwrap();
        assert_eq!(settings["day_boundary_hour"], 5);

        // 範囲外は 422 で、保存済みの値は変わらない
        let response = app()
            .oneshot(put_json_req(
                "/api/settings/notes",
                &serde_json::json!({"day_boundary_hour": 24}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);

        // read-modify-write が translate セクションを壊していない
        let base = monica_paths::base_dir().unwrap();
        let on_disk = monica_settings::Settings::load_from(&base).unwrap();
        assert_eq!(on_disk.notes.day_boundary_hour, 5);
        assert_eq!(on_disk.translate, monica_settings::TranslateSettings::default());

        // 他テストの create_note が日付跨ぎの境界に巻き込まれないよう default へ戻す
        let response = app()
            .oneshot(put_json_req(
                "/api/settings/notes",
                &serde_json::json!({"day_boundary_hour": 0}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn missing_and_invalid_note_ids_return_404() {
        for uri in ["/api/notes/note-999999", "/api/notes/..%2Fevil", "/api/notes/note-0"] {
            let response = app().oneshot(get_req(uri)).await.unwrap();
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "uri: {uri}");
        }
    }

    #[tokio::test]
    async fn delete_note_then_404() {
        let created = create_note_via_api().await;
        let id = created["id"].as_str().unwrap();
        let response = app()
            .oneshot(delete_req(&format!("/api/notes/{id}")))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        let response = app()
            .oneshot(delete_req(&format!("/api/notes/{id}")))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn restore_brings_deleted_note_back() {
        let created = create_note_via_api().await;
        let id = created["id"].as_str().unwrap();
        let response = app()
            .oneshot(delete_req(&format!("/api/notes/{id}")))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        let response = app()
            .oneshot(get_req(&format!("/api/notes/{id}")))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);

        let response = app()
            .oneshot(post_req(&format!("/api/notes/{id}/restore")))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let restored: serde_json::Value =
            serde_json::from_str(&body_string(response).await).unwrap();
        assert_eq!(restored["id"], id);

        let response = app()
            .oneshot(get_req(&format!("/api/notes/{id}")))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let response = app()
            .oneshot(post_req("/api/notes/note-999999/restore"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    // date の作為的な書き換えは DB 直叩きが要る（web crate に rusqlite を依存させたくない）ので
    // 行わない。日付レンジの境界・GROUP BY の正しさは store 層のテストが担い、ここでは
    // 「作成された note 自身の date」を使ってクエリパラメータの疎通だけを検証する。
    #[tokio::test]
    async fn list_notes_passes_range_and_returns_preview_without_content() {
        let created = create_note_via_api().await;
        let id = created["id"].as_str().unwrap();
        let date = created["date"].as_str().unwrap();

        put_note(id, None, doc_with_lines(&["preview line"])).await;

        // 自分の date を含むレンジ → 含まれる（並列テストの note と共存するため id で探す）
        let response = app()
            .oneshot(get_req(&format!("/api/notes?from={date}&to={date}")))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let list: serde_json::Value = serde_json::from_str(&body_string(response).await).unwrap();
        let entry = list
            .as_array()
            .unwrap()
            .iter()
            .find(|n| n["id"] == id)
            .expect("note must be listed within its own date range");
        assert_eq!(entry["preview"], "preview line");
        assert_eq!(entry["kind"], serde_json::json!({"kind": "daily"}));
        assert!(entry.get("content").is_none(), "summary must not ship content");

        // date を外したレンジ → 含まれない
        let response = app()
            .oneshot(get_req("/api/notes?from=1999-01-01&to=1999-01-02"))
            .await
            .unwrap();
        let list: serde_json::Value = serde_json::from_str(&body_string(response).await).unwrap();
        assert!(
            list.as_array().unwrap().iter().all(|n| n["id"] != id),
            "note must be filtered out of a range excluding its date"
        );
    }

    #[tokio::test]
    async fn by_project_lists_only_that_projects_notes_newest_first() {
        migrated();
        let store = monica_storage_sqlite::SqliteStore::open().unwrap();
        store
            .upsert_project(
                &monica_domain::Project::from_repo("webtest/by-project"),
                &monica_application::ExecutionProfile::default(),
            )
            .unwrap();

        let mut ids = Vec::new();
        for _ in 0..2 {
            let created = create_note_via_api().await;
            let id = created["id"].as_str().unwrap().to_string();
            let response = set_kind(
                &id,
                serde_json::json!({"kind": "project", "project_id": "webtest/by-project"}),
            )
            .await;
            assert_eq!(response.status(), StatusCode::OK);
            ids.push(id);
        }

        let response = app()
            .oneshot(get_req("/api/notes/by-project?project_id=webtest/by-project"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let page: serde_json::Value = serde_json::from_str(&body_string(response).await).unwrap();
        assert_eq!(page["has_more"], false);
        let items = page["items"].as_array().unwrap();
        assert_eq!(
            items.iter().map(|n| n["id"].as_str().unwrap()).collect::<Vec<_>>(),
            vec![ids[1].as_str(), ids[0].as_str()],
            "同日の note は新しい順（並列テストの note は別 project なので混ざらない）"
        );
        assert!(items[0].get("content").is_none(), "summary must not ship content");

        // offset がページ末尾を越えたら空ページ
        let response = app()
            .oneshot(get_req("/api/notes/by-project?project_id=webtest/by-project&offset=100"))
            .await
            .unwrap();
        let page: serde_json::Value = serde_json::from_str(&body_string(response).await).unwrap();
        assert!(page["items"].as_array().unwrap().is_empty());
        assert_eq!(page["has_more"], false);

        // project_id なしはクエリ検証エラー
        let response = app().oneshot(get_req("/api/notes/by-project")).await.unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    fn doc_with_lines(lines: &[&str]) -> serde_json::Value {
        let containers: Vec<serde_json::Value> = lines
            .iter()
            .map(|text| {
                serde_json::json!({
                    "type": "blockContainer",
                    "content": [{"type": "paragraph", "content": [{"type": "text", "text": text}]}],
                })
            })
            .collect();
        serde_json::json!({"type": "doc", "content": [{"type": "blockGroup", "content": containers}]})
    }

    async fn put_note(id: &str, title: Option<&str>, content: serde_json::Value) {
        let body = serde_json::json!({"title": title, "content": content});
        let response = app()
            .oneshot(put_json_req(&format!("/api/notes/{id}"), &body))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
    }

    async fn search_mentions(q: &str) -> Vec<serde_json::Value> {
        let response = app()
            .oneshot(get_req(&format!("/api/notes/mentions?q={q}")))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let list: serde_json::Value = serde_json::from_str(&body_string(response).await).unwrap();
        list.as_array().unwrap().clone()
    }

    // 検索テストは同一 DB を並列テストと共有するので、クエリは各テスト固有のマーカーにする。
    #[tokio::test]
    async fn mentions_search_finds_essay_by_title() {
        let created = create_note_via_api().await;
        let id = created["id"].as_str().unwrap();
        set_kind(id, serde_json::json!({"kind": "essay"})).await;
        put_note(id, Some("wikilink zettel alpha"), doc_with_lines(&["body"])).await;

        let found = search_mentions("wikilink%20zettel").await;
        assert_eq!(found.len(), 1);
        assert_eq!(found[0]["id"], id);
        assert_eq!(found[0]["display_name"], "wikilink zettel alpha");
    }

    #[tokio::test]
    async fn mentions_search_finds_daily_by_preview_with_date_display_name() {
        let created = create_note_via_api().await;
        let id = created["id"].as_str().unwrap();
        put_note(id, None, doc_with_lines(&["mention-preview-unique-xyz"])).await;

        let found = search_mentions("mention-preview-unique").await;
        assert_eq!(found.len(), 1);
        assert_eq!(found[0]["id"], id);
        assert_eq!(found[0]["display_name"], created["date"], "daily の表示名は date");
        assert_eq!(found[0]["preview"], "mention-preview-unique-xyz");
    }

    #[tokio::test]
    async fn mentions_search_ignores_matches_beyond_first_line() {
        let created = create_note_via_api().await;
        let id = created["id"].as_str().unwrap();
        put_note(id, None, doc_with_lines(&["first line", "deepmatch-second-line-qqq"])).await;

        // content LIKE（coarse）には引っ掛かるが、display_name / preview（precise）には
        // 一致しないので返らない。
        assert!(search_mentions("deepmatch-second-line").await.is_empty());
    }

    #[tokio::test]
    async fn mentions_search_empty_query_returns_recent_notes() {
        create_note_via_api().await;
        let found = search_mentions("").await;
        assert!(!found.is_empty());
        assert!(found.len() <= 20, "MENTION_SEARCH_LIMIT を超えない");
    }

    #[tokio::test]
    async fn mentions_resolve_returns_display_name_per_kind() {
        // untitled essay → "Untitled"
        let created = create_note_via_api().await;
        let id = created["id"].as_str().unwrap();
        set_kind(id, serde_json::json!({"kind": "essay"})).await;
        let response = app()
            .oneshot(get_req(&format!("/api/notes/mentions/{id}")))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let mention: serde_json::Value =
            serde_json::from_str(&body_string(response).await).unwrap();
        assert_eq!(mention["id"], id);
        assert_eq!(mention["display_name"], "Untitled");
        assert_eq!(mention["preview"], serde_json::Value::Null, "resolve は preview を返さない");

        // project → project_id
        migrated();
        let store = monica_storage_sqlite::SqliteStore::open().unwrap();
        store
            .upsert_project(
                &monica_domain::Project::from_repo("webtest/mention-resolve"),
                &monica_application::ExecutionProfile::default(),
            )
            .unwrap();
        let created = create_note_via_api().await;
        let id = created["id"].as_str().unwrap();
        set_kind(
            id,
            serde_json::json!({"kind": "project", "project_id": "webtest/mention-resolve"}),
        )
        .await;
        let response = app()
            .oneshot(get_req(&format!("/api/notes/mentions/{id}")))
            .await
            .unwrap();
        let mention: serde_json::Value =
            serde_json::from_str(&body_string(response).await).unwrap();
        assert_eq!(mention["display_name"], "webtest/mention-resolve");
    }

    #[tokio::test]
    async fn mentions_resolve_deleted_or_invalid_id_is_404() {
        let created = create_note_via_api().await;
        let id = created["id"].as_str().unwrap();
        let response = app()
            .oneshot(delete_req(&format!("/api/notes/{id}")))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);

        for uri in [format!("/api/notes/mentions/{id}"), "/api/notes/mentions/not-an-id".to_string()]
        {
            let response = app().oneshot(get_req(&uri)).await.unwrap();
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "uri: {uri}");
        }
    }

    #[tokio::test]
    async fn get_note_block_returns_subtree() {
        let created = create_note_via_api().await;
        let id = created["id"].as_str().unwrap();
        let content = serde_json::json!({"type": "doc", "content": [{"type": "blockGroup", "content": [
            {"type": "blockContainer", "attrs": {"id": "blk-http-1"}, "content": [
                {"type": "paragraph", "content": [{"type": "text", "text": "synced body"}]}]}]}]});
        put_note(id, None, content).await;

        let response = app()
            .oneshot(get_req(&format!("/api/notes/{id}/blocks/blk-http-1")))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let payload: serde_json::Value = serde_json::from_str(&body_string(response).await).unwrap();
        assert_eq!(payload["block"]["attrs"]["id"], "blk-http-1");
        assert_eq!(payload["block"]["content"][0]["content"][0]["text"], "synced body");
    }

    #[tokio::test]
    async fn get_note_block_missing_block_note_or_deleted_is_404() {
        let created = create_note_via_api().await;
        let id = created["id"].as_str().unwrap();
        put_note(
            id,
            None,
            serde_json::json!({"type": "doc", "content": [{"type": "blockGroup", "content": [
                {"type": "blockContainer", "attrs": {"id": "blk-http-2"}, "content": [
                    {"type": "paragraph", "content": [{"type": "text", "text": "x"}]}]}]}]}),
        )
        .await;

        // 未知 block
        let response = app()
            .oneshot(get_req(&format!("/api/notes/{id}/blocks/unknown-block")))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);

        // 未知 note
        let response = app()
            .oneshot(get_req("/api/notes/note-999999/blocks/blk-http-2"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);

        // 削除済み note
        let response =
            app().oneshot(delete_req(&format!("/api/notes/{id}"))).await.unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        let response = app()
            .oneshot(get_req(&format!("/api/notes/{id}/blocks/blk-http-2")))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn daily_counts_include_created_notes() {
        let created = create_note_via_api().await;
        let date = created["date"].as_str().unwrap();
        create_note_via_api().await;

        let response = app()
            .oneshot(get_req(&format!("/api/notes/daily-counts?from={date}&to={date}")))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let counts: serde_json::Value =
            serde_json::from_str(&body_string(response).await).unwrap();
        let entry = counts
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["date"] == date)
            .expect("created date must appear in counts");
        assert!(entry["count"].as_i64().unwrap() >= 2, "counts: {counts}");

        let response = app()
            .oneshot(get_req("/api/notes/daily-counts?from=1999-01-01&to=1999-01-02"))
            .await
            .unwrap();
        let counts: serde_json::Value =
            serde_json::from_str(&body_string(response).await).unwrap();
        assert_eq!(counts, serde_json::json!([]));
    }

    #[tokio::test]
    async fn ogp_rejects_non_http_urls() {
        for url in ["file:///etc/passwd", "ftp://example.com", "not-a-url"] {
            let response = app()
                .oneshot(get_req(&format!("/api/ogp?url={url}")))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST, "url: {url}");
        }
    }

    #[tokio::test]
    async fn ogp_requires_url_param() {
        let response = app().oneshot(get_req("/api/ogp")).await.unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn api_projects_lists_seeded_project() {
        migrated();
        let store = monica_storage_sqlite::SqliteStore::open().unwrap();
        store
            .upsert_project(
                &monica_domain::Project::from_repo("o/webtest"),
                &monica_application::ExecutionProfile::default(),
            )
            .unwrap();
        let response = app().oneshot(get_req("/api/projects")).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let list: serde_json::Value = serde_json::from_str(&body_string(response).await).unwrap();
        assert!(
            list.as_array().unwrap().iter().any(|p| p["id"] == "o/webtest"),
            "seeded project must be listed"
        );
    }

    #[tokio::test]
    async fn spa_notes_routes_return_html() {
        for uri in ["/notes", "/notes/note-1", "/settings"] {
            let response = app().oneshot(get_req(uri)).await.unwrap();
            let status = response.status();
            if WebAssets::get("index.html").is_some() {
                assert_eq!(status, StatusCode::OK, "uri: {uri}");
            } else {
                assert_eq!(status, StatusCode::NOT_FOUND, "uri: {uri}");
            }
        }
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

    fn post_bytes_req(uri: &str, body: Vec<u8>) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri(uri)
            .header("host", "127.0.0.1:19999")
            .body(Body::from(body))
            .unwrap()
    }

    #[tokio::test]
    async fn upload_png_then_serve_it() {
        let png = vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x01, 0x02, 0x03];
        let response = app().oneshot(post_bytes_req("/api/assets", png.clone())).await.unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        let asset: serde_json::Value =
            serde_json::from_str(&body_string(response).await).unwrap();
        let id = asset["id"].as_str().unwrap();
        assert!(id.ends_with(".png"));
        assert_eq!(asset["url"], format!("/api/assets/{id}"));

        let response = app().oneshot(get_req(&format!("/api/assets/{id}"))).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["content-type"], "image/png");
        assert!(
            response.headers()["cache-control"].to_str().unwrap().contains("immutable"),
            "immutable cache header"
        );
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(bytes.to_vec(), png);
    }

    #[tokio::test]
    async fn upload_svg_is_unsupported() {
        let svg = b"<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>".to_vec();
        let response = app().oneshot(post_bytes_req("/api/assets", svg)).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
    }

    #[tokio::test]
    async fn get_asset_with_malformed_id_is_404() {
        // traversal 形の id は parse_asset_id を通らないので 404（ファイル走査に到達しない）
        let response = app().oneshot(get_req("/api/assets/not-a-valid-id")).await.unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn import_rejects_non_http_url() {
        let response = app()
            .oneshot(
                post_json_req(
                    "/api/assets/import",
                    &serde_json::json!({"url": "file:///etc/passwd"}),
                )
                .await,
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[test]
    fn export_web_types() {
        let types = specta::Types::default()
            .register::<monica_api::ApiExplanation>()
            .register::<monica_api::ApiExplanationMode>()
            .register::<monica_api::ApiNote>()
            .register::<monica_api::ApiNoteSummary>()
            .register::<monica_api::ApiNotePage>()
            .register::<monica_api::ApiNoteKind>()
            .register::<monica_api::ApiNoteMention>()
            .register::<monica_api::ApiNoteBlock>()
            .register::<monica_api::ApiSetNoteKind>()
            .register::<monica_api::ApiNotesToday>()
            .register::<monica_api::NotesSettings>()
            .register::<monica_api::ApiUpdateNote>()
            .register::<monica_api::ApiDailyNoteCount>()
            .register::<monica_api::ApiLinkPreview>()
            .register::<monica_api::ApiAsset>()
            .register::<monica_api::ApiImportAsset>()
            .register::<monica_api::ProjectOption>();
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../web/src/types.gen.ts");
        specta_typescript::Typescript::default()
            .header("// This file is auto-generated by specta-typescript. Do not edit manually.\n// Regenerate with: cargo test -p monica-web --lib tests::export_web_types -- --exact\n")
            .export_to(&path, &types, specta_serde::Format)
            .expect("failed to export web types");
        // Best-effort: specta's raw output fails `just check`'s fmt-check, so format at the
        // source rather than leaving a spurious diff for every regeneration. The path is
        // canonicalized because oxfmt rejects paths containing "..".
        if let Ok(path) = path.canonicalize() {
            let _ = std::process::Command::new("bunx")
                .arg("oxfmt")
                .arg(path)
                .status();
        }
    }
}
