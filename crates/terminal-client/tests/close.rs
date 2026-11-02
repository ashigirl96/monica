use std::io::{BufRead, BufReader, Read};
use std::os::unix::net::UnixListener;
use std::sync::{mpsc, Arc};
use std::time::Duration;

use monica_terminal_client::{ClientEvent, PtydClient};
use monica_terminal_protocol::RequestOp;

#[test]
fn close_delivers_eof_resolves_pending_and_waits_for_the_reader() {
    let path = std::env::temp_dir().join(format!("monica-close-{}.sock", std::process::id()));
    let listener = UnixListener::bind(&path).unwrap();
    let (seen_tx, seen_rx) = mpsc::channel();
    let peer = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        seen_tx.send(()).unwrap();
        let mut rest = Vec::new();
        reader.read_to_end(&mut rest).unwrap();
        assert!(rest.is_empty());
    });
    let (done_tx, done_rx) = mpsc::channel();
    let client = Arc::new(
        PtydClient::connect(&path, move |event| {
            if matches!(event, ClientEvent::Disconnected) {
                done_tx.send(()).unwrap();
            }
        })
        .unwrap(),
    );
    let requesting = client.clone();
    let pending = std::thread::spawn(move || requesting.request(RequestOp::List));
    seen_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    client.close().unwrap();
    done_rx
        .try_recv()
        .expect("close must join the reader, including its callback");
    assert!(pending.join().unwrap().is_err());
    assert!(client.request(RequestOp::List).is_err());
    assert!(client.notify(RequestOp::List).is_err());
    client.close().unwrap();
    peer.join().unwrap();
    std::fs::remove_file(path).unwrap();
}

#[test]
fn close_cannot_complete_until_the_reader_callback_has_returned() {
    let path = std::env::temp_dir().join(format!("monica-join-{}.sock", std::process::id()));
    let listener = UnixListener::bind(&path).unwrap();
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let client = PtydClient::connect(&path, move |event| {
        if matches!(event, ClientEvent::Disconnected) {
            entered_tx.send(()).unwrap();
            release_rx.recv().unwrap();
        }
    })
    .unwrap();
    let (_peer, _) = listener.accept().unwrap();
    let (finished_tx, finished_rx) = mpsc::channel();
    let closer = std::thread::spawn(move || {
        client.close().unwrap();
        finished_tx.send(()).unwrap();
    });
    entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(finished_rx
        .recv_timeout(Duration::from_millis(100))
        .is_err());
    release_tx.send(()).unwrap();
    finished_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    closer.join().unwrap();
    std::fs::remove_file(path).unwrap();
}
