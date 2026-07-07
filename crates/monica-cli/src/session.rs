use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{mpsc, Arc};
use std::thread;

use anyhow::{anyhow, bail, Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use clap::Subcommand;
use monica_claude_sdk::{
    ClaudeRuntime, ClaudeSessionSummary, CreateSessionParams, SessionEvent,
};
use monica_terminal_client::{ClientEvent, PtydClient};
use monica_terminal_protocol::{RequestOp, ResponseBody, PROTOCOL_VERSION};

const DETACH_BYTE: u8 = 0x1d; // Ctrl-]
const ATTACH_REPLAY_BYTES: u32 = 64 * 1024;

#[derive(Subcommand)]
pub enum SessionCommand {
    /// Create a Claude Runtime session
    Create {
        /// Working directory for Claude Code
        #[arg(long, default_value = ".")]
        cwd: String,
        /// Initial session/tab name
        #[arg(long)]
        name: Option<String>,
        /// Claude model to pass to `claude --model`
        #[arg(long)]
        model: Option<String>,
    },
    /// List Claude Runtime sessions
    List,
    /// Send one user message to a session
    Send {
        /// Claude session id or a unique prefix
        id: String,
        /// Message text; multiple words are joined with spaces
        #[arg(required = true, num_args = 1..)]
        text: Vec<String>,
    },
    /// Stream session events until the session ends or the stream closes
    Events {
        /// Claude session id or a unique prefix
        id: String,
    },
    /// Interrupt the current turn
    Interrupt {
        /// Claude session id or a unique prefix
        id: String,
    },
    /// Attach this terminal to the session PTY; Ctrl-] detaches locally
    Attach {
        /// Claude session id or a unique prefix
        id: String,
    },
}

pub fn run(cmd: SessionCommand) -> Result<()> {
    match cmd {
        SessionCommand::Create { cwd, name, model } => create(cwd, name, model),
        SessionCommand::List => list(),
        SessionCommand::Send { id, text } => send(&id, &text.join(" ")),
        SessionCommand::Events { id } => events(&id),
        SessionCommand::Interrupt { id } => interrupt(&id),
        SessionCommand::Attach { id } => attach(&id),
    }
}

fn runtime() -> Result<ClaudeRuntime> {
    ClaudeRuntime::connect()
}

fn create(cwd: String, name: Option<String>, model: Option<String>) -> Result<()> {
    let runtime = runtime()?;
    let cwd = resolve_cwd(&cwd)?;
    let session = runtime.create_session(CreateSessionParams {
        cwd,
        model,
        title: name,
    })?;

    println!("Claude session: {}", session.claude_session_id());
    println!("Terminal session: {}", session.terminal_session_id());
    if let Some(info) = session.info() {
        println!("CWD: {}", info.cwd);
        println!("JSONL: {}", info.jsonl_path);
    }
    Ok(())
}

fn resolve_cwd(cwd: &str) -> Result<String> {
    let path = PathBuf::from(cwd);
    let path = if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .context("failed to read current directory")?
            .join(path)
    };
    let path = path
        .canonicalize()
        .with_context(|| format!("failed to resolve cwd {}", path.display()))?;
    if !path.is_dir() {
        bail!("cwd must be a directory: {}", path.display());
    }
    Ok(path.to_string_lossy().into_owned())
}

fn list() -> Result<()> {
    let runtime = runtime()?;
    let sessions = runtime.list_sessions()?;
    let attached = attached_by_terminal_session()?;
    print!("{}", render_session_table(&sessions, &attached));
    Ok(())
}

fn send(id: &str, text: &str) -> Result<()> {
    let runtime = runtime()?;
    let sessions = runtime.list_sessions()?;
    let summary = resolve_session(&sessions, id)?;
    let session = runtime.session(&summary.claude_session_id)?;
    session.send_user_message(text)?;
    println!("Sent to {}", summary.claude_session_id);
    Ok(())
}

fn events(id: &str) -> Result<()> {
    let runtime = runtime()?;
    let sessions = runtime.list_sessions()?;
    let summary = resolve_session(&sessions, id)?;
    let mut session = runtime.session(&summary.claude_session_id)?;
    loop {
        let event = session.next_event()?;
        println!("{}", format_session_event(&event));
        if event == SessionEvent::Ended {
            break;
        }
    }
    Ok(())
}

fn interrupt(id: &str) -> Result<()> {
    let runtime = runtime()?;
    let sessions = runtime.list_sessions()?;
    let summary = resolve_session(&sessions, id)?;
    let session = runtime.session(&summary.claude_session_id)?;
    session.interrupt()?;
    println!("Interrupted {}", summary.claude_session_id);
    Ok(())
}

fn attach(id: &str) -> Result<()> {
    let runtime = runtime()?;
    let sessions = runtime.list_sessions()?;
    let summary = resolve_session(&sessions, id)?;
    attach_terminal(&runtime, &summary.terminal_session_id)
        .with_context(|| format!("failed to attach to {}", summary.claude_session_id))
}

fn resolve_session<'a>(
    sessions: &'a [ClaudeSessionSummary],
    token: &str,
) -> Result<&'a ClaudeSessionSummary> {
    if token.is_empty() {
        bail!("session id cannot be empty");
    }
    if let Some(exact) = sessions.iter().find(|s| s.claude_session_id == token) {
        return Ok(exact);
    }
    let matches = sessions
        .iter()
        .filter(|s| s.claude_session_id.starts_with(token))
        .collect::<Vec<_>>();
    match matches.as_slice() {
        [one] => Ok(*one),
        [] => bail!("Claude session not found: {token}"),
        many => bail!(
            "session id prefix {token:?} is ambiguous: {}",
            many.iter()
                .map(|s| s.claude_session_id.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}

fn render_session_table(
    sessions: &[ClaudeSessionSummary],
    attached: &HashMap<String, bool>,
) -> String {
    if sessions.is_empty() {
        return "No Claude sessions found.\n".to_string();
    }
    let mut rows = vec![vec![
        "ID".to_string(),
        "NAME".to_string(),
        "STATUS".to_string(),
        "ATTACHED".to_string(),
        "CWD".to_string(),
    ]];
    for session in sessions {
        rows.push(vec![
            short_id(&session.claude_session_id).to_string(),
            crate::table::or_dash(session.name.as_deref()),
            session_status_label(session),
            if attached
                .get(&session.terminal_session_id)
                .copied()
                .unwrap_or(false)
            {
                "yes".to_string()
            } else {
                "no".to_string()
            },
            session.cwd.clone(),
        ]);
    }
    crate::table::render_table(&rows)
}

fn short_id(id: &str) -> &str {
    id.get(..8).unwrap_or(id)
}

fn session_status_label(session: &ClaudeSessionSummary) -> String {
    if session.session_status == "active" {
        match session.wait_reason.as_deref() {
            Some(reason) if session.conversation_status == "awaiting_user" => {
                format!("active/awaiting_user:{reason}")
            }
            _ => format!("active/{}", session.conversation_status),
        }
    } else {
        session.session_status.clone()
    }
}

fn format_session_event(event: &SessionEvent) -> String {
    match event {
        SessionEvent::AssistantMessage { text } => format!("assistant\t{}", single_line(text)),
        SessionEvent::ToolUse {
            tool_use_id,
            name,
            input_json,
        } => format!(
            "tool_use\t{}\t{}\t{}",
            single_line(name),
            single_line(tool_use_id),
            single_line(input_json)
        ),
        SessionEvent::AwaitingUser { wait_reason } => {
            format!(
                "awaiting_user\t{}",
                single_line(wait_reason.as_deref().unwrap_or("-"))
            )
        }
        SessionEvent::Idle => "idle".to_string(),
        SessionEvent::Ended => "ended".to_string(),
    }
}

fn single_line(value: &str) -> String {
    value.replace('\r', "\\r").replace('\n', "\\n")
}

fn attached_by_terminal_session() -> Result<HashMap<String, bool>> {
    let client = connect_ptyd(|_| {})?;
    ensure_ptyd_version(&client)?;
    let ResponseBody::Sessions { sessions } = client.request(RequestOp::List)? else {
        bail!("unexpected response to ptyd list");
    };
    Ok(sessions
        .into_iter()
        .map(|session| (session.session_id, session.attached))
        .collect())
}

fn connect_ptyd(on_event: impl Fn(ClientEvent) + Send + 'static) -> Result<PtydClient> {
    PtydClient::connect(&monica_paths::ptyd_socket_path()?, on_event)
}

fn ensure_ptyd_version(client: &PtydClient) -> Result<()> {
    let version = client.hello()?;
    if version != PROTOCOL_VERSION {
        bail!("ptyd protocol version mismatch: daemon={version}, client={PROTOCOL_VERSION}");
    }
    Ok(())
}

#[derive(Debug)]
enum AttachMessage {
    Daemon(ClientEvent),
    DetachRequested,
    StdinEof,
    StdinError(String),
}

#[derive(Debug, PartialEq, Eq)]
enum AttachStop {
    Detached,
    StdinEof,
    SessionExited(Option<i32>),
    Disconnected,
    StdinError(String),
}

struct RuntimeSyncGuard<'a> {
    runtime: &'a ClaudeRuntime,
    session_id: &'a str,
}

impl<'a> RuntimeSyncGuard<'a> {
    fn attached(runtime: &'a ClaudeRuntime, session_id: &'a str) -> Result<Self> {
        runtime.sync_terminal_session(session_id)?;
        Ok(Self { runtime, session_id })
    }
}

impl Drop for RuntimeSyncGuard<'_> {
    fn drop(&mut self) {
        let _ = self.runtime.sync_terminal_session(self.session_id);
    }
}

fn attach_terminal(runtime: &ClaudeRuntime, session_id: &str) -> Result<()> {
    let (tx, rx) = mpsc::channel();
    let event_tx = tx.clone();
    let client = Arc::new(connect_ptyd(move |event| {
        let _ = event_tx.send(AttachMessage::Daemon(event));
    })?);
    ensure_ptyd_version(&client)?;

    let stop = {
        let guard = TerminalModeGuard::enter_raw()?;
        let mut runtime_sync = None;
        let stop = (|| -> Result<AttachStop> {
            resize_to_current_terminal(&client, session_id)?;
            let attach = client.request(RequestOp::Attach {
                session_id: session_id.to_string(),
                replay_bytes: Some(ATTACH_REPLAY_BYTES),
            })?;
            let ResponseBody::Attached { replay, .. } = attach else {
                bail!("unexpected response to ptyd attach");
            };
            runtime_sync = Some(RuntimeSyncGuard::attached(runtime, session_id)?);
            resize_to_current_terminal(&client, session_id)?;

            let replay = BASE64
                .decode(replay)
                .context("daemon returned invalid replay data")?;
            let mut terminal = StdAttachTerminal { guard: &guard };
            let mut gate = AttachReplayGate::default();
            gate.write_replay(&replay, &mut terminal)?;
            let early_stop = drain_pending_messages(&rx, session_id, &mut gate)?;
            gate.flush_pending_and_enable(&mut terminal)?;

            match early_stop {
                Some(stop) => Ok(stop),
                None => {
                    spawn_stdin_forwarder(
                        Arc::clone(&client),
                        tx.clone(),
                        session_id.to_string(),
                    )?;
                    run_attach_event_loop(&rx, session_id)
                }
            }
        })();
        let _ = client.request(RequestOp::Detach {
            session_id: session_id.to_string(),
        });
        drop(runtime_sync);
        stop?
    };

    match stop {
        AttachStop::Detached => {
            eprintln!("Detached from {session_id}.");
            Ok(())
        }
        AttachStop::StdinEof => {
            eprintln!("Detached from {session_id}: stdin closed.");
            Ok(())
        }
        AttachStop::SessionExited(code) => {
            eprintln!("Session {session_id} exited with code {}.", display_exit_code(code));
            Ok(())
        }
        AttachStop::Disconnected => {
            bail!("ptyd disconnected while attached to {session_id}")
        }
        AttachStop::StdinError(error) => Err(anyhow!(error)),
    }
}

fn display_exit_code(code: Option<i32>) -> String {
    code.map_or_else(|| "-".to_string(), |code| code.to_string())
}

fn drain_pending_messages(
    rx: &mpsc::Receiver<AttachMessage>,
    session_id: &str,
    gate: &mut AttachReplayGate,
) -> Result<Option<AttachStop>> {
    let mut stop = None;
    while let Ok(message) = rx.try_recv() {
        match message {
            AttachMessage::Daemon(ClientEvent::Output { session_id: sid, data })
                if sid == session_id =>
            {
                gate.queue_base64_output(&data)?;
            }
            AttachMessage::Daemon(ClientEvent::Exit {
                session_id: sid,
                exit_code,
            }) if sid == session_id => {
                stop.get_or_insert(AttachStop::SessionExited(exit_code));
            }
            AttachMessage::Daemon(ClientEvent::Disconnected) => {
                stop.get_or_insert(AttachStop::Disconnected);
            }
            AttachMessage::DetachRequested => {
                stop.get_or_insert(AttachStop::Detached);
            }
            AttachMessage::StdinEof => {
                stop.get_or_insert(AttachStop::StdinEof);
            }
            AttachMessage::StdinError(error) => {
                stop.get_or_insert(AttachStop::StdinError(error));
            }
            _ => {}
        }
    }
    Ok(stop)
}

fn run_attach_event_loop(
    rx: &mpsc::Receiver<AttachMessage>,
    session_id: &str,
) -> Result<AttachStop> {
    loop {
        match rx.recv().context("attach event channel closed")? {
            AttachMessage::Daemon(ClientEvent::Output { session_id: sid, data })
                if sid == session_id =>
            {
                write_output(&BASE64.decode(data).context("invalid ptyd output data")?)?;
            }
            AttachMessage::Daemon(ClientEvent::Exit {
                session_id: sid,
                exit_code,
            }) if sid == session_id => return Ok(AttachStop::SessionExited(exit_code)),
            AttachMessage::Daemon(ClientEvent::Disconnected) => {
                return Ok(AttachStop::Disconnected);
            }
            AttachMessage::DetachRequested => return Ok(AttachStop::Detached),
            AttachMessage::StdinEof => return Ok(AttachStop::StdinEof),
            AttachMessage::StdinError(error) => return Ok(AttachStop::StdinError(error)),
            _ => {}
        }
    }
}

fn spawn_stdin_forwarder(
    client: Arc<PtydClient>,
    tx: mpsc::Sender<AttachMessage>,
    session_id: String,
) -> Result<()> {
    thread::Builder::new()
        .name("monica-session-stdin".to_string())
        .spawn(move || {
            let mut stdin = std::io::stdin();
            let mut buf = [0u8; 4096];
            loop {
                match stdin.read(&mut buf) {
                    Ok(0) => {
                        let _ = tx.send(AttachMessage::StdinEof);
                        return;
                    }
                    Ok(n) => {
                        let (forward, detach) = bytes_before_detach(&buf[..n]);
                        if !forward.is_empty() {
                            let result = client.notify(RequestOp::Write {
                                session_id: session_id.clone(),
                                data: BASE64.encode(forward),
                            });
                            if let Err(e) = result {
                                let _ = tx.send(AttachMessage::StdinError(format!(
                                    "failed to forward stdin to {session_id}: {e:#}"
                                )));
                                return;
                            }
                        }
                        if detach {
                            let _ = tx.send(AttachMessage::DetachRequested);
                            return;
                        }
                    }
                    Err(e) => {
                        let _ = tx.send(AttachMessage::StdinError(format!(
                            "failed to read stdin: {e}"
                        )));
                        return;
                    }
                }
            }
        })
        .context("failed to spawn stdin forwarding thread")?;
    Ok(())
}

fn bytes_before_detach(bytes: &[u8]) -> (&[u8], bool) {
    match bytes.iter().position(|b| *b == DETACH_BYTE) {
        Some(pos) => (&bytes[..pos], true),
        None => (bytes, false),
    }
}

trait AttachTerminal {
    fn write_output(&mut self, bytes: &[u8]) -> Result<()>;
    fn flush_input(&mut self) -> Result<()>;
    fn enable_stdin(&mut self);
}

#[derive(Default)]
struct AttachReplayGate {
    pending: Vec<Vec<u8>>,
    stdin_enabled: bool,
}

impl AttachReplayGate {
    fn write_replay(
        &mut self,
        replay: &[u8],
        terminal: &mut impl AttachTerminal,
    ) -> Result<()> {
        if !replay.is_empty() {
            terminal.write_output(replay)?;
        }
        Ok(())
    }

    fn queue_base64_output(&mut self, data: &str) -> Result<()> {
        self.pending
            .push(BASE64.decode(data).context("invalid ptyd output data")?);
        Ok(())
    }

    #[cfg(test)]
    fn queue_output(&mut self, bytes: &[u8]) {
        self.pending.push(bytes.to_vec());
    }

    fn flush_pending_and_enable(&mut self, terminal: &mut impl AttachTerminal) -> Result<()> {
        for bytes in self.pending.drain(..) {
            terminal.write_output(&bytes)?;
        }
        terminal.flush_input()?;
        terminal.enable_stdin();
        self.stdin_enabled = true;
        Ok(())
    }
}

struct StdAttachTerminal<'a> {
    guard: &'a TerminalModeGuard,
}

impl AttachTerminal for StdAttachTerminal<'_> {
    fn write_output(&mut self, bytes: &[u8]) -> Result<()> {
        write_output(bytes)
    }

    fn flush_input(&mut self) -> Result<()> {
        self.guard.flush_input()
    }

    fn enable_stdin(&mut self) {}
}

fn write_output(bytes: &[u8]) -> Result<()> {
    let mut stdout = std::io::stdout();
    stdout.write_all(bytes).context("failed to write terminal output")?;
    stdout.flush().context("failed to flush terminal output")?;
    Ok(())
}

struct TerminalModeGuard {
    fd: libc::c_int,
    original: libc::termios,
}

impl TerminalModeGuard {
    fn enter_raw() -> Result<Self> {
        let stdin_fd = libc::STDIN_FILENO;
        let stdout_fd = libc::STDOUT_FILENO;
        // SAFETY: isatty is read-only for the supplied file descriptors.
        unsafe {
            if libc::isatty(stdin_fd) != 1 || libc::isatty(stdout_fd) != 1 {
                bail!("session attach requires an interactive terminal on stdin/stdout");
            }
            let mut original = std::mem::zeroed();
            if libc::tcgetattr(stdin_fd, &mut original) != 0 {
                return Err(std::io::Error::last_os_error())
                    .context("failed to read terminal mode");
            }
            let mut raw = original;
            libc::cfmakeraw(&mut raw);
            if libc::tcsetattr(stdin_fd, libc::TCSANOW, &raw) != 0 {
                return Err(std::io::Error::last_os_error())
                    .context("failed to enter raw terminal mode");
            }
            Ok(Self {
                fd: stdin_fd,
                original,
            })
        }
    }

    fn flush_input(&self) -> Result<()> {
        // SAFETY: tcflush only affects the input queue for the fd owned by this guard.
        unsafe {
            if libc::tcflush(self.fd, libc::TCIFLUSH) != 0 {
                return Err(std::io::Error::last_os_error())
                    .context("failed to flush terminal input");
            }
        }
        Ok(())
    }
}

impl Drop for TerminalModeGuard {
    fn drop(&mut self) {
        // SAFETY: restores the termios snapshot captured by enter_raw.
        unsafe {
            let _ = libc::tcsetattr(self.fd, libc::TCSANOW, &self.original);
        }
    }
}

fn resize_to_current_terminal(client: &PtydClient, session_id: &str) -> Result<()> {
    let Some((rows, cols)) = current_terminal_size() else {
        return Ok(());
    };
    client.notify(RequestOp::Resize {
        session_id: session_id.to_string(),
        rows,
        cols,
    })?;
    Ok(())
}

fn current_terminal_size() -> Option<(u16, u16)> {
    // SAFETY: ioctl fills the provided winsize struct for stdout when it is a TTY.
    unsafe {
        let mut winsize: libc::winsize = std::mem::zeroed();
        if libc::ioctl(libc::STDOUT_FILENO, libc::TIOCGWINSZ, &mut winsize) != 0 {
            return None;
        }
        if winsize.ws_row == 0 || winsize.ws_col == 0 {
            return None;
        }
        Some((winsize.ws_row, winsize.ws_col))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(id: &str, name: Option<&str>) -> ClaudeSessionSummary {
        ClaudeSessionSummary {
            claude_session_id: id.to_string(),
            tab_id: format!("tab-{id}"),
            terminal_session_id: format!("ts-{id}"),
            cwd: "/tmp/monica".to_string(),
            name: name.map(str::to_string),
            session_status: "active".to_string(),
            conversation_status: "idle".to_string(),
            wait_reason: None,
            created_at: "2026-07-06T00:00:00Z".to_string(),
            ended_at: None,
            stuck_launching: false,
        }
    }

    #[test]
    fn resolve_cwd_returns_an_absolute_existing_directory() {
        let cwd = resolve_cwd(".").unwrap();
        let path = PathBuf::from(cwd);
        assert!(path.is_absolute());
        assert!(path.is_dir());
    }

    #[test]
    fn resolve_session_prefers_exact_then_unique_prefix() {
        let sessions = vec![
            summary("abcdef00-0000-4000-8000-000000000000", Some("one")),
            summary("abc99999-0000-4000-8000-000000000000", Some("two")),
        ];
        assert_eq!(
            resolve_session(&sessions, "abcdef").unwrap().name.as_deref(),
            Some("one")
        );
        assert_eq!(
            resolve_session(&sessions, "abcdef00-0000-4000-8000-000000000000")
                .unwrap()
                .name
                .as_deref(),
            Some("one")
        );
        assert!(resolve_session(&sessions, "abc").is_err());
        assert!(resolve_session(&sessions, "missing").is_err());
    }

    #[test]
    fn render_session_table_formats_status_and_attachment() {
        let mut sessions = vec![summary("abcdef00-0000-4000-8000-000000000000", Some("work"))];
        sessions[0].conversation_status = "awaiting_user".to_string();
        sessions[0].wait_reason = Some("permission".to_string());
        let attached = HashMap::from([(sessions[0].terminal_session_id.clone(), true)]);
        let rendered = render_session_table(&sessions, &attached);
        assert!(rendered.contains("abcdef00"));
        assert!(rendered.contains("work"));
        assert!(rendered.contains("active/awaiting_user:permission"));
        assert!(rendered.contains("yes"));
    }

    #[test]
    fn format_session_event_is_one_line() {
        assert_eq!(
            format_session_event(&SessionEvent::AssistantMessage {
                text: "hello\nworld".to_string()
            }),
            "assistant\thello\\nworld"
        );
        assert_eq!(
            format_session_event(&SessionEvent::ToolUse {
                tool_use_id: "t1".to_string(),
                name: "Bash".to_string(),
                input_json: "{\"cmd\":\"x\"}".to_string(),
            }),
            "tool_use\tBash\tt1\t{\"cmd\":\"x\"}"
        );
        assert_eq!(
            format_session_event(&SessionEvent::AwaitingUser { wait_reason: None }),
            "awaiting_user\t-"
        );
    }

    #[derive(Default)]
    struct FakeTerminal {
        ops: Vec<String>,
    }

    impl AttachTerminal for FakeTerminal {
        fn write_output(&mut self, bytes: &[u8]) -> Result<()> {
            self.ops
                .push(format!("write:{}", String::from_utf8_lossy(bytes)));
            Ok(())
        }

        fn flush_input(&mut self) -> Result<()> {
            self.ops.push("flush_input".to_string());
            Ok(())
        }

        fn enable_stdin(&mut self) {
            self.ops.push("enable_stdin".to_string());
        }
    }

    #[test]
    fn replay_gate_flushes_pending_before_enabling_stdin() {
        let mut gate = AttachReplayGate::default();
        let mut terminal = FakeTerminal::default();
        gate.queue_output(b"live-1");
        gate.queue_output(b"live-2");

        gate.write_replay(b"replay", &mut terminal).unwrap();
        assert_eq!(terminal.ops, vec!["write:replay"]);

        gate.flush_pending_and_enable(&mut terminal).unwrap();
        assert!(gate.stdin_enabled);
        assert_eq!(
            terminal.ops,
            vec![
                "write:replay",
                "write:live-1",
                "write:live-2",
                "flush_input",
                "enable_stdin",
            ]
        );
    }

    #[test]
    fn ctrl_right_bracket_detaches_without_forwarding_the_marker() {
        assert_eq!(bytes_before_detach(b"abc"), (b"abc".as_slice(), false));
        assert_eq!(
            bytes_before_detach(&[b'a', DETACH_BYTE, b'b']),
            (b"a".as_slice(), true)
        );
    }

    #[test]
    fn drain_pending_detects_disconnect_after_buffering_output() {
        let (tx, rx) = mpsc::channel();
        tx.send(AttachMessage::Daemon(ClientEvent::Output {
            session_id: "ts-1".to_string(),
            data: BASE64.encode(b"live"),
        }))
        .unwrap();
        tx.send(AttachMessage::Daemon(ClientEvent::Disconnected))
            .unwrap();

        let mut gate = AttachReplayGate::default();
        let stop = drain_pending_messages(&rx, "ts-1", &mut gate).unwrap();
        assert_eq!(stop, Some(AttachStop::Disconnected));
        let mut terminal = FakeTerminal::default();
        gate.flush_pending_and_enable(&mut terminal).unwrap();
        assert_eq!(
            terminal.ops,
            vec!["write:live", "flush_input", "enable_stdin"]
        );
    }
}
