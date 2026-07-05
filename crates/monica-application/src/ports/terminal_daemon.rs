use anyhow::Result;

use crate::usecases::terminal::DaemonSessionView;

/// What the application needs to spawn a PTY session, independent of the wire protocol.
pub struct TerminalCreateRequest {
    pub session_id: String,
    pub cwd: String,
    pub shell: String,
    pub rows: u16,
    pub cols: u16,
    pub env: Vec<(String, String)>,
}

/// A successful attach: the base64 transcript tail to replay plus the live geometry.
pub struct TerminalAttachment {
    pub replay: String,
    pub rows: u16,
    pub cols: u16,
}

/// Command-initiated terminal daemon operations. Implemented by the desktop's ptyd adapter and
/// injected per call (the daemon connection is driver-owned, not part of the façade). The
/// reader-thread `Exit`/`Reap` path stays in the driver — it is not modelled here.
pub trait TerminalDaemon {
    /// Spawn the session; returns the live pid when the daemon reports one.
    fn create(&self, request: TerminalCreateRequest) -> Result<Option<u32>>;
    /// Type `data` into the session's PTY, waiting for the freshly spawned shell to be
    /// ready to read input first, and return only once the daemon has acknowledged the
    /// write. Backs the SDK launch injection, where "submitted before anyone else can
    /// write" is a correctness requirement, not a latency optimization.
    fn write_input(&self, session_id: &str, data: &[u8]) -> Result<()>;
    fn attach(&self, session_id: &str, replay_bytes: Option<u32>) -> Result<TerminalAttachment>;
    fn detach(&self, session_id: &str) -> Result<()>;
    fn terminate(&self, session_id: &str) -> Result<()>;
    fn list_views(&self) -> Result<Vec<DaemonSessionView>>;
    /// Best-effort reap notification for a session the reconcile decided is gone.
    fn reap(&self, session_id: &str);
}
