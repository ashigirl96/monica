use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{State, WebSocketUpgrade};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;

use crate::origin;
use crate::protocol::ServerMessage;
use crate::translate;

#[derive(Clone)]
pub struct AppState {
    pub allowed_origins: Arc<Vec<String>>,
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

    Ok(ws.on_upgrade(handle_socket))
}

async fn handle_socket(socket: WebSocket) {
    let (mut sender, mut receiver) = socket.split();

    let segments: Vec<crate::protocol::Segment> = loop {
        match receiver.next().await {
            Some(Ok(Message::Text(text))) => match serde_json::from_str(&text) {
                Ok(segs) => break segs,
                Err(e) => {
                    let msg = ServerMessage::Error {
                        message: format!("invalid segments: {e}"),
                    };
                    let _ = sender
                        .send(Message::Text(serde_json::to_string(&msg).unwrap().into()))
                        .await;
                    return;
                }
            },
            Some(Ok(Message::Close(_))) | None => return,
            _ => continue,
        }
    };

    let request_start = std::time::Instant::now();
    log::info!("ws request: {} segments", segments.len());

    let (tx, mut rx) = mpsc::channel(64);

    let translate_handle = tokio::spawn(async move { translate::translate(segments, tx).await });

    let mut sent = 0usize;
    while let Some(st) = rx.recv().await {
        let msg = ServerMessage::Translation(st);
        if let Ok(json) = serde_json::to_string(&msg) {
            if sender.send(Message::Text(json.into())).await.is_err() {
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

    log::info!(
        "ws request finished: {sent} translations delivered in {}ms",
        request_start.elapsed().as_millis(),
    );

    let final_msg = match translate_handle.await {
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

    let _ = sender
        .send(Message::Text(
            serde_json::to_string(&final_msg).unwrap().into(),
        ))
        .await;
    let _ = sender.close().await;
}

pub async fn run_server(addr: SocketAddr, allowed_origins: Vec<String>) -> std::io::Result<()> {
    let state = AppState {
        allowed_origins: Arc::new(allowed_origins),
    };

    let listener = tokio::net::TcpListener::bind(addr).await?;
    let bound_addr = listener.local_addr()?;
    log::info!("browser-bridge listening on ws://{bound_addr}/ws/translate");

    axum::serve(listener, build_router(state))
        .await
        .map_err(std::io::Error::other)
}
