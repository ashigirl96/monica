use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;

use axum::Router;
use axum::extract::ws::{Message, WebSocket};
use axum::extract::{State, WebSocketUpgrade};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use axum::routing::get;
use futures_util::stream::SplitSink;
use futures_util::{SinkExt, StreamExt};
use monica_settings::TranslateSettings;
use tokio::sync::{Semaphore, mpsc};

use crate::origin;
use crate::protocol::{SegTranslation, Segment, ServerMessage};
use crate::translate;

/// 1 WS 接続 = 1 claude サブプロセスなので、この値がそのまま claude の同時起動上限。
pub const MAX_CONCURRENT_SESSIONS: usize = 4;
pub const MAX_SEGMENTS: usize = 1024;

pub type TranslateFuture = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;
pub type Translator =
    Arc<dyn Fn(Vec<Segment>, mpsc::Sender<SegTranslation>) -> TranslateFuture + Send + Sync>;

#[derive(Clone)]
pub struct AppState {
    pub allowed_origins: Arc<Vec<String>>,
    sessions: Arc<Semaphore>,
    translator: Translator,
}

impl AppState {
    pub fn new(allowed_origins: Vec<String>, translator: Translator) -> Self {
        Self {
            allowed_origins: Arc::new(allowed_origins),
            sessions: Arc::new(Semaphore::new(MAX_CONCURRENT_SESSIONS)),
            translator,
        }
    }
}

pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/ws/translate", get(ws_handler))
        .with_state(state)
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    headers: HeaderMap,
    State(state): State<AppState>,
) -> Result<Response, StatusCode> {
    let origin = headers.get("origin").and_then(|v| v.to_str().ok());

    if !origin::check_origin(origin, &state.allowed_origins) {
        log::warn!(
            "rejected WS from origin: {}",
            origin.unwrap_or("<missing>")
        );
        return Err(StatusCode::FORBIDDEN);
    }

    Ok(ws.on_upgrade(move |socket| handle_socket(socket, state)))
}

async fn send_error(sender: &mut SplitSink<WebSocket, Message>, message: String) {
    let msg = ServerMessage::Error { message };
    if let Ok(json) = serde_json::to_string(&msg) {
        let _ = sender.send(Message::Text(json.into())).await;
    }
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let (mut sender, mut receiver) = socket.split();

    let segments: Vec<Segment> = loop {
        match receiver.next().await {
            Some(Ok(Message::Text(text))) => match serde_json::from_str(&text) {
                Ok(segs) => break segs,
                Err(e) => {
                    send_error(&mut sender, format!("invalid segments: {e}")).await;
                    return;
                }
            },
            Some(Ok(Message::Close(_))) | None => return,
            _ => continue,
        }
    };

    if segments.len() > MAX_SEGMENTS {
        log::warn!("rejected request: {} segments > {MAX_SEGMENTS}", segments.len());
        send_error(
            &mut sender,
            format!("too many segments: {} > {MAX_SEGMENTS}", segments.len()),
        )
        .await;
        return;
    }

    // permit はこの関数を抜けるまで保持 = 翻訳完了まで 1 スロット占有
    let Ok(_permit) = state.sessions.clone().try_acquire_owned() else {
        log::warn!("rejected request: too many concurrent translations");
        send_error(&mut sender, "busy: too many concurrent translations".into()).await;
        return;
    };

    let request_start = std::time::Instant::now();
    log::info!("ws request: {} segments", segments.len());

    let (tx, mut rx) = mpsc::channel(64);

    let translate_handle = tokio::spawn((state.translator)(segments, tx));

    let mut sent = 0usize;
    let mut client_gone = false;
    loop {
        tokio::select! {
            st = rx.recv() => match st {
                Some(st) => {
                    let msg = ServerMessage::Translation(st);
                    if let Ok(json) = serde_json::to_string(&msg) {
                        if sender.send(Message::Text(json.into())).await.is_err() {
                            client_gone = true;
                            break;
                        }
                        sent += 1;
                        if sent == 1 {
                            log::info!(
                                "first translation delivered in {}ms",
                                request_start.elapsed().as_millis(),
                            );
                        }
                    }
                }
                None => break,
            },
            frame = receiver.next() => match frame {
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => {
                    client_gone = true;
                    break;
                }
                // extension の keepalive "ping" 等はここで読み捨てる。受信側を
                // 待ち続けることが切断（Close/EOF）の即時検出そのもの
                Some(Ok(_)) => {}
            },
        }
    }

    if client_gone {
        // 届け先が消えた。translate ごと abort し、future の drop で
        // Query → actor → claude 子プロセスまで終了させる（kill_on_drop）
        translate_handle.abort();
    }
    drop(rx);

    log::info!(
        "ws request finished: {sent} translations delivered in {}ms",
        request_start.elapsed().as_millis(),
    );

    let outcome = translate_handle.await;
    if client_gone {
        return;
    }
    let final_msg = match outcome {
        Ok(Ok(())) => ServerMessage::Done {},
        Ok(Err(e)) => {
            log::error!("translation failed: {e}");
            ServerMessage::Error { message: e }
        }
        Err(e) => {
            log::error!("translate task panicked: {e}");
            ServerMessage::Error {
                message: "internal error".to_string(),
            }
        }
    };

    if let Ok(json) = serde_json::to_string(&final_msg) {
        let _ = sender.send(Message::Text(json.into())).await;
    }
    let _ = sender.close().await;
}

pub async fn run_server(addr: SocketAddr, settings: TranslateSettings) -> std::io::Result<()> {
    let model = settings.model;
    let effort = settings.effort;
    let translator: Translator = Arc::new(move |segments, tx| {
        Box::pin(translate::translate(segments, tx, model, effort))
    });
    let state = AppState::new(settings.allowed_origins, translator);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    let bound_addr = listener.local_addr()?;
    log::info!("browser-bridge listening on ws://{bound_addr}/ws/translate");

    axum::serve(listener, build_router(state))
        .await
        .map_err(std::io::Error::other)
}
