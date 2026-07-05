//! NDJSON wire protocol between external SDK clients (`monica-claude-sdk`) and the desktop
//! app's SDK control socket (`<base>/sdk.sock`): one JSON object per line over a Unix domain
//! socket, one request/response pair per connection.
//!
//! This is the Rust-client half of the external IPC surface; browser clients get a separate
//! localhost WebSocket in MVP7.

use serde::{Deserialize, Serialize};

/// Bump on any incompatible wire change — semantic contracts included, not just shape.
/// The server rejects a mismatched version with an `Err` response before doing anything,
/// so version skew fails with no side effect.
///
/// v2: `OpenSdkSession.claude_session_id` is required and the server must honor it
/// (idempotent opens). v1 servers ignored the field and minted their own id, so a v2
/// client's "safe retry" against a v1 server would have opened a second session — the
/// bump makes v1 servers reject the request before launching instead.
pub const PROTOCOL_VERSION: u32 = 2;

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
        /// Idempotency key, REQUIRED in v2 (the server rejects requests without it
        /// before creating anything): opening with an id that is already mapped to a
        /// live session returns that session instead of creating a second one, so a
        /// retry after a lost response is safe — and because the client minted the key,
        /// it survives any lost response. `Option` only so a v1-era line still parses
        /// far enough to be answered with a version-mismatch error. v1 servers ignored
        /// the field, which is why the version bump — not the echoed id in the response
        /// — is what protects retries against them.
        #[serde(default)]
        claude_session_id: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SdkResponse {
    Ok {
        session: SdkSessionInfo,
    },
    Err {
        error: String,
        /// The server could not determine the outcome either (e.g. the id maps to a
        /// launch reservation that is still unconfirmed, or liveness could not be
        /// verified): a session may exist under the requested id, so the client must
        /// retry with the same id, never a fresh one. `false` — the default, so
        /// determinate errors parse unchanged — proves no session was left behind.
        #[serde(default)]
        indeterminate: bool,
    },
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
    /// Absolute transcript path, resolved server-side so the slug derivation stays in one
    /// place. `None` only from servers predating this field.
    #[serde(default)]
    pub jsonl_path: Option<String>,
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
                claude_session_id: Some("5e0f5b0e-9f5c-4a4e-9d6e-000000000000".into()),
            },
        };
        let back = round_trip_request(&req);
        assert_eq!(back.version, PROTOCOL_VERSION);
        let SdkRequestOp::OpenSdkSession { cwd, model, title, claude_session_id } = back.op;
        assert_eq!(cwd, "/tmp");
        assert_eq!(model.as_deref(), Some("opus"));
        assert_eq!(title, None);
        assert_eq!(
            claude_session_id.as_deref(),
            Some("5e0f5b0e-9f5c-4a4e-9d6e-000000000000")
        );
    }

    #[test]
    fn optional_fields_may_be_omitted_on_the_wire() {
        // A v1 request written before claude_session_id existed must still parse (fields
        // default), so the server can answer it with a version-mismatch error instead of
        // an opaque parse error.
        let back: SdkRequest =
            serde_json::from_str(r#"{"version":1,"op":"open_sdk_session","cwd":"/tmp"}"#).unwrap();
        let SdkRequestOp::OpenSdkSession { cwd, model, title, claude_session_id } = back.op;
        assert_eq!(cwd, "/tmp");
        assert_eq!(model, None);
        assert_eq!(title, None);
        assert_eq!(claude_session_id, None);
    }

    #[test]
    fn session_info_without_jsonl_path_still_parses() {
        // A response from a server predating jsonl_path must still parse client-side.
        let session: SdkSessionInfo = serde_json::from_str(
            r#"{"runspace_id":"sdk","tab_id":"t","session_id":"ts-1",
                "claude_session_id":"u","cwd":"/tmp","initial_command":"claude"}"#,
        )
        .unwrap();
        assert_eq!(session.jsonl_path, None);
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
                jsonl_path: Some("/Users/me/.claude/projects/-tmp/u.jsonl".into()),
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

        let err = SdkResponse::Err { error: "nope".into(), indeterminate: false };
        match round_trip_response(&err) {
            SdkResponse::Err { error, indeterminate } => {
                assert_eq!(error, "nope");
                assert!(!indeterminate);
            }
            other => panic!("unexpected response: {other:?}"),
        }

        let unresolved = SdkResponse::Err { error: "unconfirmed".into(), indeterminate: true };
        match round_trip_response(&unresolved) {
            SdkResponse::Err { indeterminate, .. } => assert!(indeterminate),
            other => panic!("unexpected response: {other:?}"),
        }
    }

    #[test]
    fn err_without_the_indeterminate_field_parses_as_determinate() {
        // A v1-era error line carries no flag; it must keep meaning "nothing was created".
        let back: SdkResponse = serde_json::from_str(r#"{"type":"err","error":"nope"}"#).unwrap();
        match back {
            SdkResponse::Err { indeterminate, .. } => assert!(!indeterminate),
            other => panic!("unexpected response: {other:?}"),
        }
    }
}
