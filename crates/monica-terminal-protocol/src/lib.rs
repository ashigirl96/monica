//! NDJSON wire protocol between the Tauri app and `monica-ptyd`: one JSON object per line
//! over a Unix domain socket. Binary payloads (PTY input/output, replay) are base64.
//!
//! Delivery rules the daemon must uphold:
//! - `Output` events go only to connections attached to that session (fanout).
//! - `Exit` events broadcast to every connection regardless of attachments, so a detached
//!   session's exit still reaches the app for DB recording + reap. Receivers ignore exits
//!   for sessions they don't know.

use std::io::{self, BufRead, Write};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

/// Bump on any incompatible wire change. The client refuses to talk to a daemon with a
/// different version and restarts it instead.
pub const PROTOCOL_VERSION: u32 = 1;

/// Encode a value as one NDJSON line (no trailing newline).
pub fn to_frame<T: ?Sized + Serialize>(value: &T) -> serde_json::Result<String> {
    serde_json::to_string(value)
}

/// Write an already-encoded line as an NDJSON frame: line + `\n` + flush.
///
/// The flush is load-bearing: callers wrap a `BufWriter`, so dropping it would leave a request
/// or response sitting in the buffer until the next write, stalling the round trip.
pub fn write_line<W: Write>(w: &mut W, line: &str) -> io::Result<()> {
    w.write_all(line.as_bytes())?;
    w.write_all(b"\n")?;
    w.flush()
}

/// Serialize a value and write it as one NDJSON frame.
pub fn write_frame<W: Write, T: ?Sized + Serialize>(w: &mut W, value: &T) -> io::Result<()> {
    let line = to_frame(value).map_err(io::Error::other)?;
    write_line(w, &line)
}

/// A frame that arrived but failed to deserialize. `Display` renders `({source}): {line}` so a
/// caller can log it with its own prefix and keep the raw line for diagnosis.
#[derive(Debug)]
pub struct FrameError {
    pub line: String,
    pub source: serde_json::Error,
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "({}): {}", self.source, self.line)
    }
}

impl std::error::Error for FrameError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.source)
    }
}

/// Read NDJSON frames from a reader: stop at the first io error, skip blank lines, and yield one
/// parse result per non-blank line. Callers decide what to do with a `FrameError` (typically warn
/// and continue) and drive whatever dispatch the parsed value needs.
pub fn read_frames<R, T>(reader: R) -> impl Iterator<Item = Result<T, FrameError>>
where
    R: BufRead,
    T: DeserializeOwned,
{
    let mut lines = reader.lines();
    std::iter::from_fn(move || loop {
        let line = match lines.next() {
            Some(Ok(line)) => line,
            Some(Err(_)) | None => return None,
        };
        if line.trim().is_empty() {
            continue;
        }
        return Some(serde_json::from_str::<T>(&line).map_err(|source| FrameError { line, source }));
    })
}

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

    #[test]
    fn write_frame_appends_exactly_one_trailing_newline() {
        let msg = ServerMessage::Exit {
            session_id: "ts-1".into(),
            exit_code: None,
        };
        let mut buf = Vec::new();
        write_frame(&mut buf, &msg).unwrap();
        let written = String::from_utf8(buf).unwrap();
        assert_eq!(written, format!("{}\n", to_frame(&msg).unwrap()));
        assert_eq!(written.matches('\n').count(), 1);
    }

    #[test]
    fn read_frames_skips_blank_lines_and_flags_unparseable_ones() {
        let req = Request {
            id: Some(1),
            op: RequestOp::List,
        };
        let mut input: Vec<u8> = Vec::new();
        write_frame(&mut input, &req).unwrap();
        input.extend_from_slice(b"\n"); // blank line between frames
        input.extend_from_slice(b"   \n"); // whitespace-only line
        input.extend_from_slice(b"{not json}\n");
        write_frame(&mut input, &req).unwrap();

        let results: Vec<_> = read_frames::<_, Request>(input.as_slice()).collect();
        assert_eq!(results.len(), 3, "two valid frames + one unparseable");
        assert!(matches!(results[0], Ok(Request { id: Some(1), .. })));
        assert!(results[1].is_err());
        assert!(matches!(results[2], Ok(Request { id: Some(1), .. })));
    }

    #[test]
    fn write_frame_then_read_frames_round_trips() {
        let messages = [
            ServerMessage::Output {
                session_id: "ts-1".into(),
                data: "aGk=".into(),
            },
            ServerMessage::Exit {
                session_id: "ts-1".into(),
                exit_code: Some(0),
            },
        ];
        let mut buf = Vec::new();
        for msg in &messages {
            write_frame(&mut buf, msg).unwrap();
        }
        let back: Vec<ServerMessage> = read_frames::<_, ServerMessage>(buf.as_slice())
            .map(Result::unwrap)
            .collect();
        assert_eq!(back.len(), 2);
        assert!(matches!(back[0], ServerMessage::Output { .. }));
        assert!(matches!(back[1], ServerMessage::Exit { exit_code: Some(0), .. }));
    }
}
