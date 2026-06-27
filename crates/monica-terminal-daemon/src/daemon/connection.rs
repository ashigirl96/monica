use std::io::{BufRead, BufReader, BufWriter, Write};
use std::os::unix::net::UnixStream;
use std::sync::mpsc;
use std::sync::Arc;

use anyhow::Result;

use monica_terminal_protocol::{Request, RequestOp, ResponseBody, ServerMessage, PROTOCOL_VERSION};

use super::state::{Outbox, SessionTable};

const OUTBOX_CAPACITY: usize = 256;

pub fn serve_connection(stream: UnixStream, table: Arc<SessionTable>, conn_id: u64) {
    let write_stream = match stream.try_clone() {
        Ok(s) => s,
        Err(e) => {
            log::error!("failed to clone connection stream: {e}");
            return;
        }
    };
    let (tx, rx) = mpsc::sync_channel::<String>(OUTBOX_CAPACITY);
    let writer = std::thread::Builder::new()
        .name(format!("ptyd-writer-{conn_id}"))
        .spawn(move || {
            let mut w = BufWriter::new(write_stream);
            for line in rx {
                let ok = w
                    .write_all(line.as_bytes())
                    .and_then(|_| w.write_all(b"\n"))
                    .and_then(|_| w.flush())
                    .is_ok();
                if !ok {
                    break;
                }
            }
        });
    if writer.is_err() {
        log::error!("failed to spawn writer thread for connection {conn_id}");
        return;
    }

    let outbox = Outbox::new(tx);
    table.register_connection(conn_id, outbox.clone());
    log::debug!("connection {conn_id} established");

    let reader = BufReader::new(stream);
    for line in reader.lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let request: Request = match serde_json::from_str(&line) {
            Ok(req) => req,
            Err(e) => {
                log::warn!("connection {conn_id}: unparseable request ({e}): {line}");
                continue;
            }
        };
        let shutdown = matches!(request.op, RequestOp::Shutdown);
        if let Some(response) = dispatch(&table, conn_id, request) {
            if !outbox.send(&response) {
                break;
            }
        }
        if shutdown {
            log::info!("shutdown requested by connection {conn_id}");
            // exit() skips destructors; the children get SIGHUP when the process's pty
            // masters close, which is the intended teardown for a daemon replace.
            std::process::exit(0);
        }
    }

    // EOF = the client went away (app quit or crashed): implicit detach of everything it
    // was watching, while the sessions themselves keep running and draining to transcripts.
    table.drop_connection(conn_id);
    log::debug!("connection {conn_id} closed");
}

fn dispatch(table: &Arc<SessionTable>, conn_id: u64, request: Request) -> Option<ServerMessage> {
    let result: Result<ResponseBody> = match request.op {
        RequestOp::Hello { .. } => Ok(ResponseBody::Hello {
            version: PROTOCOL_VERSION,
        }),
        RequestOp::Create(params) => table
            .create(params)
            .map(|pid| ResponseBody::Created { pid }),
        RequestOp::Write { session_id, data } => table
            .write(&session_id, &data)
            .map(|_| ResponseBody::Empty),
        RequestOp::Resize {
            session_id,
            rows,
            cols,
        } => table
            .resize(&session_id, rows, cols)
            .map(|_| ResponseBody::Empty),
        RequestOp::Terminate { session_id } => {
            table.terminate(&session_id).map(|_| ResponseBody::Empty)
        }
        RequestOp::List => Ok(ResponseBody::Sessions {
            sessions: table.list(),
        }),
        RequestOp::Attach {
            session_id,
            replay_bytes,
        } => table
            .attach(&session_id, conn_id, replay_bytes)
            .map(|(replay, rows, cols)| ResponseBody::Attached { replay, rows, cols }),
        RequestOp::Detach { session_id } => {
            table.detach(&session_id, conn_id);
            Ok(ResponseBody::Empty)
        }
        RequestOp::Reap { session_id } => {
            table.reap(&session_id);
            Ok(ResponseBody::Empty)
        }
        RequestOp::Shutdown => Ok(ResponseBody::Empty),
    };

    let id = request.id?;
    Some(match result {
        Ok(body) => ServerMessage::Ok { id, body },
        Err(e) => ServerMessage::Err {
            id,
            error: format!("{e:#}"),
        },
    })
}
