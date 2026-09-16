//! The one place this crate starts an external process, so every invocation leaves a line naming
//! the command, its working directory, its exit status and how long it took.
//!
//! Lines are `<event> key=value …` so a single field can be pulled back out with
//! `rg 'duration_ms=…'`. Success is DEBUG and failure is WARN, except for the non-zero exits that
//! are answers rather than failures (`git show-ref` on a missing branch, `kill -KILL` on a process
//! that already died) — those are declared with [`Exec::benign`] and stay DEBUG, because the CLI
//! logger defaults to WARN and a warning on every healthy run is a warning nobody reads.
//!
//! stdout is never logged: `gh auth token` answers with the token itself.

use std::borrow::Cow;
use std::io;
use std::process::{Child, Command, ExitStatus, Output};
use std::time::Instant;

// Log targets for this crate's outward boundaries, gathered here so `MONICA_LOG=monica_adapters=debug`
// has one list to raise and no call site invents a spelling of its own.
pub(crate) const GIT: &str = "monica_adapters::git";
pub(crate) const GH: &str = "monica_adapters::gh";
pub(crate) const GITHUB: &str = "monica_adapters::github";
pub(crate) const HTTP: &str = "monica_adapters::http";
pub(crate) const SETUP: &str = "monica_adapters::setup";
pub(crate) const TRASH: &str = "monica_adapters::worktree_trash";

const STDERR_LINES: usize = 3;
const STDERR_BYTES: usize = 300;

/// Prefixes of GitHub credentials, longest first so `github_pat_` is not shadowed by a shorter one.
const TOKEN_PREFIXES: &[&str] = &["github_pat_", "ghp_", "gho_", "ghu_", "ghs_", "ghr_"];

pub(crate) struct Exec<'a> {
    target: &'static str,
    command: &'a mut Command,
    benign: &'static [i32],
    spawn_is_benign: bool,
    fields: Vec<(&'static str, String)>,
}

impl<'a> Exec<'a> {
    pub(crate) fn new(target: &'static str, command: &'a mut Command) -> Self {
        Self {
            target,
            command,
            benign: &[],
            spawn_is_benign: false,
            fields: Vec::new(),
        }
    }

    /// Exit codes that are an answer rather than a failure, and so stay at DEBUG.
    pub(crate) fn benign(mut self, codes: &'static [i32]) -> Self {
        self.benign = codes;
        self
    }

    /// Mark a spawn failure as expected, for a command being probed among several candidates.
    /// The search as a whole still reports its own failure when no candidate works.
    pub(crate) fn probing(mut self) -> Self {
        self.spawn_is_benign = true;
        self
    }

    pub(crate) fn attempt(self, n: u32) -> Self {
        self.field("attempt", n.to_string())
    }

    /// Add a correlation id or other context the call site knows and the command does not.
    pub(crate) fn field(mut self, key: &'static str, value: impl Into<String>) -> Self {
        self.fields.push((key, value.into()));
        self
    }

    pub(crate) fn output(mut self) -> io::Result<Output> {
        let started = Instant::now();
        let result = self.command.output();
        match &result {
            Ok(output) => self.finished(started, output.status, Some(&output.stderr)),
            Err(e) => self.not_started(started, e),
        }
        result
    }

    pub(crate) fn status(mut self) -> io::Result<ExitStatus> {
        let started = Instant::now();
        let result = self.command.status();
        match &result {
            Ok(status) => self.finished(started, *status, None),
            Err(e) => self.not_started(started, e),
        }
        result
    }

    /// Records only whether the process started. Its exit is the caller's to report, since a
    /// spawned child is waited on somewhere else entirely — or deliberately not at all.
    pub(crate) fn spawn(mut self) -> io::Result<Child> {
        let started = Instant::now();
        let result = self.command.spawn();
        match &result {
            Ok(child) => {
                self.fields.push(("pid", child.id().to_string()));
                self.emit("spawn", log::Level::Debug, started);
            }
            Err(e) => {
                self.fields.push(("error", e.to_string()));
                let level = if self.spawn_is_benign {
                    log::Level::Debug
                } else {
                    log::Level::Warn
                };
                self.emit("spawn", level, started);
            }
        }
        result
    }

    fn finished(&mut self, started: Instant, status: ExitStatus, stderr: Option<&[u8]>) {
        let level = level(status.code(), status.success(), self.benign);
        match status.code() {
            Some(code) => self.fields.push(("exit", code.to_string())),
            None => self.fields.push(("exit", "signal".to_string())),
        }
        if level == log::Level::Warn {
            if let Some(stderr) = stderr.filter(|s| !s.is_empty()) {
                self.fields.push(("stderr", clip(stderr)));
            }
        }
        self.emit("exec", level, started);
    }

    fn not_started(&mut self, started: Instant, error: &io::Error) {
        self.fields.push(("error", error.to_string()));
        let level = if self.spawn_is_benign {
            log::Level::Debug
        } else {
            log::Level::Warn
        };
        self.emit("exec", level, started);
    }

    fn emit(&self, event: &str, level: log::Level, started: Instant) {
        if !log::log_enabled!(target: self.target, level) {
            return;
        }
        let mut fields = vec![("cmd", describe(self.command)), ("cwd", cwd(self.command))];
        fields.extend(self.fields.iter().map(|(k, v)| (*k, v.clone())));
        fields.push(("duration_ms", started.elapsed().as_millis().to_string()));
        log::log!(target: self.target, level, "{}", render(event, &fields));
    }
}

/// The command as it would be typed, with any credential in an argument masked.
fn describe(command: &Command) -> String {
    let mut parts = vec![command.get_program().to_string_lossy().into_owned()];
    parts.extend(
        command
            .get_args()
            .map(|arg| redact(&arg.to_string_lossy()).into_owned()),
    );
    parts.join(" ")
}

/// A command that sets no working directory inherits this process's, which is where it really runs.
/// `git -C <repo>` takes that route on purpose, and the repo stays visible in `cmd=`.
fn cwd(command: &Command) -> String {
    match command.get_current_dir() {
        Some(dir) => dir.to_string_lossy().into_owned(),
        None => std::env::current_dir()
            .map(|dir| dir.to_string_lossy().into_owned())
            .unwrap_or_default(),
    }
}

/// The trimmed stderr of a failed command, for an error message that has to stand on its own.
pub(crate) fn stderr_message(stderr: &[u8]) -> String {
    let stderr = String::from_utf8_lossy(stderr);
    let stderr = stderr.trim();
    if stderr.is_empty() {
        "no error output".to_string()
    } else {
        redact(stderr).into_owned()
    }
}

pub(crate) fn render(event: &str, fields: &[(&str, String)]) -> String {
    let mut line = String::from(event);
    for (key, value) in fields {
        line.push(' ');
        line.push_str(key);
        line.push('=');
        line.push_str(&quote(value));
    }
    line
}

fn quote(value: &str) -> Cow<'_, str> {
    let bare = !value.is_empty()
        && value
            .bytes()
            .all(|b| !b.is_ascii_whitespace() && b != b'"' && b != b'=' && b != b'\\');
    if bare {
        return Cow::Borrowed(value);
    }
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            _ => out.push(ch),
        }
    }
    out.push('"');
    Cow::Owned(out)
}

fn level(exit: Option<i32>, success: bool, benign: &[i32]) -> log::Level {
    if success {
        return log::Level::Debug;
    }
    match exit {
        Some(code) if benign.contains(&code) => log::Level::Debug,
        _ => log::Level::Warn,
    }
}

/// The head of a command's stderr, folded onto one line so it stays inside its `stderr=` field.
fn clip(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let mut head = String::new();
    for line in text.lines().filter(|l| !l.trim().is_empty()).take(STDERR_LINES) {
        if !head.is_empty() {
            head.push('\n');
        }
        head.push_str(line.trim_end());
        if head.len() >= STDERR_BYTES {
            break;
        }
    }
    if head.len() > STDERR_BYTES {
        let end = (0..=STDERR_BYTES).rev().find(|i| head.is_char_boundary(*i)).unwrap_or(0);
        head.truncate(end);
        head.push('…');
    }
    redact(&head).into_owned()
}

/// Mask GitHub credentials, keeping the prefix so the kind of token stays readable.
pub(crate) fn redact(value: &str) -> Cow<'_, str> {
    let Some(mut hit) = find_token(value, 0) else {
        return Cow::Borrowed(value);
    };
    let mut out = String::with_capacity(value.len());
    let mut cursor = 0;
    loop {
        let (start, prefix_len, end) = hit;
        out.push_str(&value[cursor..start + prefix_len]);
        out.push_str("***");
        cursor = end;
        match find_token(value, cursor) {
            Some(next) => hit = next,
            None => break,
        }
    }
    out.push_str(&value[cursor..]);
    Cow::Owned(out)
}

/// The earliest credential at or after `from`, as `(start, prefix length, end)`.
fn find_token(value: &str, from: usize) -> Option<(usize, usize, usize)> {
    TOKEN_PREFIXES
        .iter()
        .filter_map(|prefix| {
            let start = from + value[from..].find(prefix)?;
            let body = start + prefix.len();
            let len = value[body..]
                .find(|c: char| !c.is_ascii_alphanumeric() && c != '_')
                .unwrap_or(value.len() - body);
            (len > 0).then_some((start, prefix.len(), body + len))
        })
        .min_by_key(|(start, ..)| *start)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL_TARGETS: &[&str] = &[GIT, GH, GITHUB, HTTP, SETUP, TRASH];

    /// fern matches a target by `::` segment, so a target that does not name this crate is
    /// unreachable from `MONICA_LOG=<crate>=debug`. Anchoring on the package name (not
    /// `CARGO_CRATE_NAME`, which a `[lib] name` override changes) makes a crate rename fail here.
    #[test]
    fn every_target_is_reachable_from_this_crate_name() {
        let crate_name = env!("CARGO_PKG_NAME").replace('-', "_");
        for target in ALL_TARGETS {
            let rest = target.strip_prefix(&crate_name);
            assert!(
                rest.is_some_and(|rest| rest.is_empty() || rest.starts_with("::")),
                "{target} is unreachable from MONICA_LOG={crate_name}=debug"
            );
        }
    }

    fn fields(pairs: &[(&'static str, &str)]) -> Vec<(&'static str, String)> {
        pairs.iter().map(|(k, v)| (*k, v.to_string())).collect()
    }

    #[test]
    fn render_lays_out_the_event_then_its_fields() {
        let line = render("exec", &fields(&[("exit", "0"), ("duration_ms", "12")]));
        assert_eq!(line, "exec exit=0 duration_ms=12");
    }

    #[test]
    fn a_value_with_whitespace_or_a_delimiter_is_quoted() {
        let line = render(
            "exec",
            &fields(&[("cmd", "git worktree add"), ("cwd", "/tmp/repo"), ("note", "a=b")]),
        );
        assert_eq!(line, r#"exec cmd="git worktree add" cwd=/tmp/repo note="a=b""#);
    }

    #[test]
    fn an_empty_value_stays_visible_as_an_empty_field() {
        assert_eq!(render("exec", &fields(&[("cwd", "")])), r#"exec cwd="""#);
    }

    #[test]
    fn a_quote_or_newline_inside_a_value_is_escaped_rather_than_ending_the_field() {
        let line = render("exec", &fields(&[("stderr", "fatal: \"x\"\nsecond")]));
        assert_eq!(line, r#"exec stderr="fatal: \"x\"\nsecond""#);
    }

    #[test]
    fn success_is_debug_and_an_unexpected_failure_is_warn() {
        assert_eq!(level(Some(0), true, &[]), log::Level::Debug);
        assert_eq!(level(Some(128), false, &[]), log::Level::Warn);
    }

    #[test]
    fn a_declared_benign_exit_code_stays_debug() {
        assert_eq!(level(Some(1), false, &[1]), log::Level::Debug);
        assert_eq!(level(Some(2), false, &[1]), log::Level::Warn);
    }

    /// A process killed by a signal reports no code, so it can never be declared benign.
    #[test]
    fn a_signal_death_is_warn_even_with_benign_codes() {
        assert_eq!(level(None, false, &[1]), log::Level::Warn);
    }

    #[test]
    fn a_github_token_is_masked_but_its_kind_is_kept() {
        assert_eq!(redact("ghp_abc123DEF456"), "ghp_***");
        assert_eq!(redact("token github_pat_11ABCdef_xyz here"), "token github_pat_*** here");
    }

    #[test]
    fn every_token_on_a_line_is_masked() {
        assert_eq!(redact("a ghp_one b gho_two c"), "a ghp_*** b gho_*** c");
    }

    #[test]
    fn ordinary_text_is_passed_through_untouched() {
        assert!(matches!(redact("fatal: not a git repository"), Cow::Borrowed(_)));
        // A bare prefix with no body is not a token.
        assert_eq!(redact("ghp_"), "ghp_");
    }

    #[test]
    fn clip_keeps_the_first_lines_and_folds_them_onto_one() {
        let stderr = b"first\nsecond\nthird\nfourth" as &[u8];
        assert_eq!(clip(stderr), "first\nsecond\nthird");
        assert_eq!(render("exec", &fields(&[("stderr", &clip(stderr))])).lines().count(), 1);
    }

    #[test]
    fn clip_truncates_a_long_line_on_a_char_boundary() {
        let stderr = "é".repeat(400).into_bytes();
        let clipped = clip(&stderr);
        assert!(clipped.len() <= STDERR_BYTES + '…'.len_utf8());
        assert!(clipped.ends_with('…'));
    }

    #[test]
    fn clip_masks_a_token_that_leaked_into_stderr() {
        assert_eq!(clip(b"failed with ghp_secretvalue"), "failed with ghp_***");
    }

    #[test]
    fn describe_reads_the_command_back_and_masks_its_arguments() {
        let mut command = Command::new("git");
        command.arg("-C").arg("/tmp/repo").arg("status");
        assert_eq!(describe(&command), "git -C /tmp/repo status");

        let mut command = Command::new("curl");
        command.arg("-H").arg("Authorization: token ghp_abc123");
        assert_eq!(describe(&command), "curl -H Authorization: token ghp_***");
    }

    #[test]
    fn a_command_without_its_own_directory_reports_this_process_cwd() {
        let expected = std::env::current_dir().unwrap().to_string_lossy().into_owned();
        assert_eq!(cwd(&Command::new("git")), expected);

        let mut located = Command::new("git");
        located.current_dir("/tmp");
        assert_eq!(cwd(&located), "/tmp");
    }

    #[test]
    fn stderr_message_names_the_absence_of_output() {
        assert_eq!(stderr_message(b"  \n"), "no error output");
        assert_eq!(stderr_message(b"  fatal: boom\n"), "fatal: boom");
    }

    /// Logging must not change what the caller sees.
    #[test]
    fn the_output_of_the_command_is_returned_unchanged() {
        let mut command = Command::new("/bin/sh");
        command.arg("-c").arg("printf out; printf err >&2; exit 3");
        let output = Exec::new(GIT, &mut command).output().unwrap();
        assert_eq!(output.status.code(), Some(3));
        assert_eq!(output.stdout, b"out");
        assert_eq!(output.stderr, b"err");
    }

    #[test]
    fn a_command_that_does_not_exist_returns_its_spawn_error() {
        let mut command = Command::new("/nonexistent/monica-exec-test");
        let error = Exec::new(GIT, &mut command).probing().output().unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::NotFound);
    }
}
