//! NDJSON wire protocol between the Tauri app and `monica-ptyd`: one JSON object per line
//! over a Unix domain socket. Binary payloads (PTY input/output, replay) are base64.
//!
//! Delivery rules the daemon must uphold:
//! - `Output` events go only to connections attached to that session (fanout).
//! - `Exit` events broadcast to every connection regardless of attachments, so a detached
//!   session's exit still reaches the app for DB recording + reap. Receivers ignore exits
//!   for sessions they don't know.

use serde::{Deserialize, Serialize};

mod input;

pub use input::{bracketed_paste_bytes, SUBMIT_DELAY};

/// Bump on any incompatible wire change. The client refuses to talk to a daemon with a
/// different version and restarts it instead.
pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Request {
    /// Correlation id for the response. `None` marks a notification (no response sent);
    /// used for write/resize to keep keystroke latency free of a round trip.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<u64>,
    #[serde(flatten)]
    pub op: RequestOp,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum RequestOp {
    Hello {
        version: u32,
    },
    Create(CreateParams),
    Write {
        session_id: String,
        data: String,
    },
    Resize {
        session_id: String,
        rows: u16,
        cols: u16,
    },
    Terminate {
        session_id: String,
    },
    List,
    Attach {
        session_id: String,
        #[serde(default)]
        replay_bytes: Option<u32>,
    },
    Detach {
        session_id: String,
    },
    /// Drop an exited session's tombstone (and transcript) once the DB reflects the exit.
    Reap {
        session_id: String,
    },
    Shutdown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateParams {
    pub session_id: String,
    pub cwd: String,
    #[serde(default)]
    pub shell: Option<String>,
    pub rows: u16,
    pub cols: u16,
    #[serde(default)]
    pub env: Option<Vec<(String, String)>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
    Ok {
        id: u64,
        #[serde(flatten)]
        body: ResponseBody,
    },
    Err {
        id: u64,
        error: String,
    },
    Output {
        session_id: String,
        data: String,
    },
    Exit {
        session_id: String,
        exit_code: Option<i32>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "body", rename_all = "snake_case")]
pub enum ResponseBody {
    Empty,
    Hello {
        version: u32,
    },
    Created {
        pid: Option<u32>,
    },
    Attached {
        replay: String,
        rows: u16,
        cols: u16,
    },
    Sessions {
        sessions: Vec<SessionInfo>,
    },
}

/// One session as the daemon sees it: live (`running: true`) or an exited tombstone
/// awaiting reap (`running: false`, `exit_code` populated when the wait succeeded).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    pub session_id: String,
    pub running: bool,
    /// True when at least one connection is attached (receiving Output events).
    pub attached: bool,
    pub pid: Option<u32>,
    pub exit_code: Option<i32>,
    pub cwd: String,
    pub rows: u16,
    pub cols: u16,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round_trip_request(req: &Request) -> Request {
        let line = serde_json::to_string(req).unwrap();
        assert!(!line.contains('\n'), "wire format must stay one line");
        serde_json::from_str(&line).unwrap()
    }

    fn round_trip_message(msg: &ServerMessage) -> ServerMessage {
        let line = serde_json::to_string(msg).unwrap();
        assert!(!line.contains('\n'));
        serde_json::from_str(&line).unwrap()
    }

    #[test]
    fn request_round_trips_through_ndjson() {
        let req = Request {
            id: Some(7),
            op: RequestOp::Create(CreateParams {
                session_id: "ts-1".into(),
                cwd: "/tmp".into(),
                shell: Some("/bin/zsh".into()),
                rows: 24,
                cols: 80,
                env: Some(vec![("A".into(), "b".into())]),
            }),
        };
        let back = round_trip_request(&req);
        assert_eq!(back.id, Some(7));
        match back.op {
            RequestOp::Create(params) => {
                assert_eq!(params.session_id, "ts-1");
                assert_eq!(params.env.as_deref(), Some(&[("A".into(), "b".into())][..]));
            }
            other => panic!("unexpected op: {other:?}"),
        }
    }

    #[test]
    fn notification_omits_id_on_the_wire() {
        let req = Request {
            id: None,
            op: RequestOp::Write {
                session_id: "ts-1".into(),
                data: "aGk=".into(),
            },
        };
        let line = serde_json::to_string(&req).unwrap();
        assert!(!line.contains("\"id\""));
        let back: Request = serde_json::from_str(&line).unwrap();
        assert_eq!(back.id, None);
    }

    #[test]
    fn server_messages_round_trip() {
        let attached = ServerMessage::Ok {
            id: 1,
            body: ResponseBody::Attached {
                replay: "aGk=".into(),
                rows: 24,
                cols: 80,
            },
        };
        match round_trip_message(&attached) {
            ServerMessage::Ok {
                id: 1,
                body: ResponseBody::Attached { replay, rows, cols },
            } => {
                assert_eq!(replay, "aGk=");
                assert_eq!((rows, cols), (24, 80));
            }
            other => panic!("unexpected message: {other:?}"),
        }

        let exit = ServerMessage::Exit {
            session_id: "ts-1".into(),
            exit_code: Some(130),
        };
        match round_trip_message(&exit) {
            ServerMessage::Exit {
                session_id,
                exit_code,
            } => {
                assert_eq!(session_id, "ts-1");
                assert_eq!(exit_code, Some(130));
            }
            other => panic!("unexpected message: {other:?}"),
        }
    }
}
