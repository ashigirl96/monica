//! WS サーバの統合テスト。port 0 で実サーバを立て、tokio-tungstenite の
//! 実クライアントで handshake / Origin 拒否 / 上限 / 切断時 abort を検証する。
//! translator は fake を注入するので claude には依存しない。

use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use monica_browser_bridge::protocol::SegTranslation;
use monica_browser_bridge::server::{AppState, MAX_SEGMENTS, Translator, build_router};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

const OK_ORIGIN: &str = "https://ok.example";

type Client = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

async fn start_server(translator: Translator) -> SocketAddr {
    let state = AppState::new(vec![OK_ORIGIN.to_string()], translator);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, build_router(state)).await.unwrap();
    });
    addr
}

fn echo_translator() -> Translator {
    Arc::new(|segments, tx| {
        Box::pin(async move {
            for s in segments {
                let _ = tx
                    .send(SegTranslation {
                        seg: s.seg,
                        translation: format!("訳{}", s.seg),
                    })
                    .await;
            }
            Ok(())
        })
    })
}

/// 開始で started を立て、drop（= abort 含む）で dropped を立てる translator。
fn stalling_translator(started: Arc<AtomicBool>, dropped: Arc<AtomicBool>) -> Translator {
    struct DropFlag(Arc<AtomicBool>);
    impl Drop for DropFlag {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }
    Arc::new(move |_segments, tx| {
        let guard = DropFlag(dropped.clone());
        let started = started.clone();
        Box::pin(async move {
            // tx を drop すると server が「翻訳完了」と解釈するので保持し続ける
            let _tx = tx;
            let _guard = guard;
            started.store(true, Ordering::SeqCst);
            std::future::pending::<()>().await;
            Ok(())
        })
    })
}

async fn connect(addr: SocketAddr, origin: Option<&str>) -> Result<Client, WsError> {
    let mut request = format!("ws://{addr}/ws/translate")
        .into_client_request()
        .unwrap();
    if let Some(origin) = origin {
        request
            .headers_mut()
            .insert("Origin", origin.parse().unwrap());
    }
    connect_async(request).await.map(|(ws, _)| ws)
}

fn segments_json(count: usize) -> String {
    let segs: Vec<_> = (1..=count as u64)
        .map(|seg| serde_json::json!({ "seg": seg, "text": format!("text {seg}") }))
        .collect();
    serde_json::Value::Array(segs).to_string()
}

async fn next_json(ws: &mut Client) -> serde_json::Value {
    loop {
        match tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("timed out waiting for server message")
            .expect("connection closed unexpectedly")
            .expect("ws read error")
        {
            Message::Text(text) => return serde_json::from_str(&text).unwrap(),
            _ => continue,
        }
    }
}

async fn wait_for(flag: &AtomicBool) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !flag.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("flag was never set");
}

#[tokio::test]
async fn handshake_streams_translations_then_done() {
    let addr = start_server(echo_translator()).await;
    let mut ws = connect(addr, Some(OK_ORIGIN)).await.unwrap();

    ws.send(Message::Text(segments_json(2).into()))
        .await
        .unwrap();

    let first = next_json(&mut ws).await;
    assert_eq!(first["type"], "translation");
    assert_eq!(first["seg"], 1);
    assert_eq!(first["translation"], "訳1");

    let second = next_json(&mut ws).await;
    assert_eq!(second["seg"], 2);

    let done = next_json(&mut ws).await;
    assert_eq!(done["type"], "done");
}

#[tokio::test]
async fn disallowed_origin_is_rejected_before_upgrade() {
    let addr = start_server(echo_translator()).await;
    match connect(addr, Some("https://evil.example")).await {
        Err(WsError::Http(response)) => assert_eq!(response.status(), 403),
        other => panic!("expected HTTP 403, got {other:?}"),
    }
}

#[tokio::test]
async fn missing_origin_is_rejected_before_upgrade() {
    let addr = start_server(echo_translator()).await;
    match connect(addr, None).await {
        Err(WsError::Http(response)) => assert_eq!(response.status(), 403),
        other => panic!("expected HTTP 403, got {other:?}"),
    }
}

#[tokio::test]
async fn oversized_request_is_rejected() {
    let addr = start_server(echo_translator()).await;
    let mut ws = connect(addr, Some(OK_ORIGIN)).await.unwrap();

    ws.send(Message::Text(segments_json(MAX_SEGMENTS + 1).into()))
        .await
        .unwrap();

    let msg = next_json(&mut ws).await;
    assert_eq!(msg["type"], "error");
    assert!(
        msg["message"].as_str().unwrap().contains("too many segments"),
        "unexpected error: {msg}"
    );
}

#[tokio::test]
async fn concurrent_sessions_beyond_limit_get_busy() {
    let started = Arc::new(AtomicBool::new(false));
    let dropped = Arc::new(AtomicBool::new(false));
    let addr = start_server(stalling_translator(started, dropped)).await;

    // MAX_CONCURRENT_SESSIONS(4) の permit を使い切る
    let mut held = Vec::new();
    for _ in 0..4 {
        let mut ws = connect(addr, Some(OK_ORIGIN)).await.unwrap();
        ws.send(Message::Text(segments_json(1).into()))
            .await
            .unwrap();
        held.push(ws);
    }

    let mut ws = connect(addr, Some(OK_ORIGIN)).await.unwrap();
    ws.send(Message::Text(segments_json(1).into()))
        .await
        .unwrap();
    let msg = next_json(&mut ws).await;
    assert_eq!(msg["type"], "error");
    assert!(
        msg["message"].as_str().unwrap().contains("busy"),
        "unexpected error: {msg}"
    );
}

#[tokio::test]
async fn client_disconnect_aborts_translation() {
    let started = Arc::new(AtomicBool::new(false));
    let dropped = Arc::new(AtomicBool::new(false));
    let addr = start_server(stalling_translator(started.clone(), dropped.clone())).await;

    let mut ws = connect(addr, Some(OK_ORIGIN)).await.unwrap();
    ws.send(Message::Text(segments_json(1).into()))
        .await
        .unwrap();

    wait_for(&started).await;
    assert!(!dropped.load(Ordering::SeqCst));

    // クライアント切断 → server が translate task を abort → future drop を観測。
    // 実 claude ではこの drop が Query → actor → kill_on_drop で子プロセス終了に繋がる
    ws.close(None).await.unwrap();
    drop(ws);

    wait_for(&dropped).await;
}
