//! NDJSON wire protocol between external SDK clients (`monica-claude-sdk`) and the desktop
//! app's SDK control socket (`<base>/sdk.sock`): one JSON object per line over a Unix domain
//! socket, one request/response pair per connection.
//!
//! This is the Rust-client half of the external IPC surface; browser clients get a separate
//! localhost WebSocket in MVP7.

use serde::{Deserialize, Serialize};

/// Bump on any incompatible wire change. The server answers a mismatched version with an
/// `Err` response instead of guessing.
pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SdkRequest {
    pub version: u32,
    #[serde(flatten)]
    pub op: SdkRequestOp,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum SdkRequestOp {
    OpenSdkSession {
        cwd: String,
        #[serde(default)]
        model: Option<String>,
        #[serde(default)]
        title: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SdkResponse {
    Ok { session: SdkSessionInfo },
    Err { error: String },
}

/// The created session as the app reports it back to the SDK client. `claude_session_id`
/// is the pre-minted UUID Claude runs under, so the transcript path
/// (`~/.claude/projects/<slug>/<uuid>.jsonl`) is known before Claude finishes starting.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SdkSessionInfo {
    pub runspace_id: String,
    pub tab_id: String,
    pub session_id: String,
    pub claude_session_id: String,
    pub cwd: String,
    pub initial_command: String,
    #[serde(default)]
    pub title: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round_trip_request(req: &SdkRequest) -> SdkRequest {
        let line = serde_json::to_string(req).unwrap();
        assert!(!line.contains('\n'), "wire format must stay one line");
        serde_json::from_str(&line).unwrap()
    }

    fn round_trip_response(res: &SdkResponse) -> SdkResponse {
        let line = serde_json::to_string(res).unwrap();
        assert!(!line.contains('\n'));
        serde_json::from_str(&line).unwrap()
    }

    #[test]
    fn request_round_trips_through_ndjson() {
        let req = SdkRequest {
            version: PROTOCOL_VERSION,
            op: SdkRequestOp::OpenSdkSession {
                cwd: "/tmp".into(),
                model: Some("opus".into()),
                title: None,
            },
        };
        let back = round_trip_request(&req);
        assert_eq!(back.version, PROTOCOL_VERSION);
        let SdkRequestOp::OpenSdkSession { cwd, model, title } = back.op;
        assert_eq!(cwd, "/tmp");
        assert_eq!(model.as_deref(), Some("opus"));
        assert_eq!(title, None);
    }

    #[test]
    fn optional_fields_may_be_omitted_on_the_wire() {
        let back: SdkRequest =
            serde_json::from_str(r#"{"version":1,"op":"open_sdk_session","cwd":"/tmp"}"#).unwrap();
        let SdkRequestOp::OpenSdkSession { cwd, model, title } = back.op;
        assert_eq!(cwd, "/tmp");
        assert_eq!(model, None);
        assert_eq!(title, None);
    }

    #[test]
    fn responses_round_trip() {
        let ok = SdkResponse::Ok {
            session: SdkSessionInfo {
                runspace_id: "sdk".into(),
                tab_id: "tab-1".into(),
                session_id: "ts-1".into(),
                claude_session_id: "5e0f5b0e-9f5c-4a4e-9d6e-000000000000".into(),
                cwd: "/tmp".into(),
                initial_command: "claude --session-id x".into(),
                title: Some("t".into()),
            },
        };
        match round_trip_response(&ok) {
            SdkResponse::Ok { session } => {
                assert_eq!(session.runspace_id, "sdk");
                assert_eq!(session.session_id, "ts-1");
                assert_eq!(session.title.as_deref(), Some("t"));
            }
            other => panic!("unexpected response: {other:?}"),
        }

        let err = SdkResponse::Err { error: "nope".into() };
        match round_trip_response(&err) {
            SdkResponse::Err { error } => assert_eq!(error, "nope"),
            other => panic!("unexpected response: {other:?}"),
        }
    }
}
