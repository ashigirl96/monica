//! One line per Tauri command call, `key=value` throughout so a single invocation can be pulled
//! back out of `monica.log` with `rg 'command=prepare_task'`.
//!
//! The ok level belongs to the call site because command call frequency spans three orders of
//! magnitude: `terminal_write` runs once per keystroke and the board polls every three seconds,
//! so logging every command at INFO would push the startup banner and the real failures out of
//! the 1MB x 5 rotation within hours. A failure is WARN whatever the class, so `result=err` is
//! never invisible at the default level.

use std::future::Future;
use std::time::{Duration, Instant};

use monica_api::ApiError;

const TARGET: &str = "monica_app::commands";

const MAX_VALUE: usize = 200;
const MAX_MESSAGE: usize = 300;

/// Correlation ids and the few arguments worth recording, in call-site order.
#[derive(Default)]
pub struct Ids(Vec<(&'static str, String)>);

impl Ids {
    pub fn with(mut self, key: &'static str, value: impl IdValue) -> Self {
        self.push(key, value);
        self
    }

    pub fn push(&mut self, key: &'static str, value: impl IdValue) {
        if let Some(value) = value.id_value() {
            self.0.push((key, value));
        }
    }
}

/// An absent id is omitted rather than rendered as `key=None`, so `rg 'task_id='` only matches
/// calls that actually carried one.
pub trait IdValue {
    fn id_value(self) -> Option<String>;
}

impl IdValue for &str {
    fn id_value(self) -> Option<String> {
        Some(self.to_owned())
    }
}

impl IdValue for &String {
    fn id_value(self) -> Option<String> {
        Some(self.clone())
    }
}

impl IdValue for &Option<String> {
    fn id_value(self) -> Option<String> {
        self.clone()
    }
}

impl IdValue for usize {
    fn id_value(self) -> Option<String> {
        Some(self.to_string())
    }
}

/// Build [`Ids`] from parameter names, so the key in the log is the identifier in the signature
/// and the two cannot drift. A field whose key differs from the binding (or whose value is not a
/// binding at all) uses [`Ids::with`] instead.
macro_rules! ids {
    ($($key:ident),* $(,)?) => {{
        #[allow(unused_mut)]
        let mut ids = $crate::command_log::Ids::default();
        $( ids.push(stringify!($key), &$key); )*
        ids
    }};
}

pub(crate) use ids;

/// A command that changes state — one per user action. INFO, the default level.
pub async fn operation<T>(
    cmd: &'static str,
    ids: Ids,
    fut: impl Future<Output = Result<T, ApiError>>,
) -> Result<T, ApiError> {
    run(cmd, log::Level::Info, ids, fut).await
}

/// A read, including the ones the frontend polls every three seconds. DEBUG.
pub async fn routine<T>(
    cmd: &'static str,
    ids: Ids,
    fut: impl Future<Output = Result<T, ApiError>>,
) -> Result<T, ApiError> {
    run(cmd, log::Level::Debug, ids, fut).await
}

/// A command driven by input or frame rate rather than by a user action. TRACE.
pub async fn stream<T>(
    cmd: &'static str,
    ids: Ids,
    fut: impl Future<Output = Result<T, ApiError>>,
) -> Result<T, ApiError> {
    run(cmd, log::Level::Trace, ids, fut).await
}

/// [`operation`] for a command that is deliberately synchronous (see `clipboard::write_image`).
pub fn operation_sync<T>(
    cmd: &'static str,
    ids: Ids,
    f: impl FnOnce() -> Result<T, ApiError>,
) -> Result<T, ApiError> {
    let started = Instant::now();
    let result = f();
    record(cmd, log::Level::Info, &ids, started.elapsed(), result.as_ref().err());
    result
}

/// [`routine`] for a synchronous read with no failure mode, which still deserves a line so a slow
/// one is visible.
pub fn routine_infallible<T>(cmd: &'static str, ids: Ids, f: impl FnOnce() -> T) -> T {
    let started = Instant::now();
    let value = f();
    record(cmd, log::Level::Debug, &ids, started.elapsed(), None);
    value
}

async fn run<T>(
    cmd: &'static str,
    ok_level: log::Level,
    ids: Ids,
    fut: impl Future<Output = Result<T, ApiError>>,
) -> Result<T, ApiError> {
    let started = Instant::now();
    let result = fut.await;
    record(cmd, ok_level, &ids, started.elapsed(), result.as_ref().err());
    result
}

fn record(
    cmd: &'static str,
    ok_level: log::Level,
    ids: &Ids,
    elapsed: Duration,
    error: Option<&ApiError>,
) {
    let level = if error.is_some() { log::Level::Warn } else { ok_level };
    // `stream` commands are filtered out at the default level, and they are the ones that run per
    // keystroke — checking first keeps the formatting off that path entirely.
    if !log::log_enabled!(target: TARGET, level) {
        return;
    }
    log::log!(
        target: TARGET,
        level,
        "{}",
        canonical_line(cmd, ids, elapsed.as_millis(), error)
    );
}

fn canonical_line(cmd: &str, ids: &Ids, duration_ms: u128, error: Option<&ApiError>) -> String {
    let mut fields = vec![format!("command={cmd}")];
    fields.extend(ids.0.iter().map(|(key, value)| format!("{key}={}", field(value, MAX_VALUE))));
    fields.push(format!("duration_ms={duration_ms}"));
    match error {
        None => fields.push("result=ok".to_owned()),
        Some(error) => {
            fields.push("result=err".to_owned());
            fields.push(format!("code={}", error.code.as_str()));
            fields.push(format!("message={}", field(&error.message, MAX_MESSAGE)));
        }
    }
    fields.join(" ")
}

/// A `key=value` pair stays greppable only while the value holds no whitespace, and one line per
/// call only holds while nothing embeds a newline — an `ApiError` message carries `{e:#}` output,
/// which does both. Flatten, cap, and quote whatever is left.
fn field(value: &str, max_chars: usize) -> String {
    let flat: String =
        value.chars().map(|c| if c.is_control() { ' ' } else { c }).collect::<String>();
    let capped = if flat.chars().count() > max_chars {
        format!("{}…", flat.chars().take(max_chars).collect::<String>())
    } else {
        flat
    };
    if capped.is_empty() || capped.contains(|c: char| c.is_whitespace() || c == '"') {
        format!("\"{}\"", capped.replace('"', "\\\""))
    } else {
        capped
    }
}

#[cfg(test)]
mod tests {
    use monica_api::{ApiError, ApiErrorCode};

    use super::{canonical_line, field, Ids, MAX_MESSAGE};

    #[test]
    fn ok_line_carries_the_ids_in_call_site_order() {
        let ids = Ids::default().with("task_id", "MON-42").with("tab_id", "tab-1");
        assert_eq!(
            canonical_line("prepare_task", &ids, 37, None),
            "command=prepare_task task_id=MON-42 tab_id=tab-1 duration_ms=37 result=ok"
        );
    }

    #[test]
    fn err_line_carries_the_frontend_facing_code() {
        let error = ApiError::new(ApiErrorCode::Conflict, "task already running");
        assert_eq!(
            canonical_line("launch_task", &Ids::default().with("task_id", "MON-42"), 5, Some(&error)),
            "command=launch_task task_id=MON-42 duration_ms=5 result=err code=conflict \
             message=\"task already running\""
        );
    }

    #[test]
    fn a_command_without_ids_still_logs_one_line() {
        assert_eq!(
            canonical_line("list_projects", &Ids::default(), 0, None),
            "command=list_projects duration_ms=0 result=ok"
        );
    }

    #[test]
    fn absent_optional_ids_are_omitted_rather_than_rendered() {
        let ids = Ids::default().with("runspace_id", &None).with("session_id", &Some("s-1".to_owned()));
        assert_eq!(
            canonical_line("terminal_list_sessions", &ids, 1, None),
            "command=terminal_list_sessions session_id=s-1 duration_ms=1 result=ok"
        );
    }

    #[test]
    fn the_macro_takes_the_key_from_the_binding_name() {
        let task_id = "MON-42".to_owned();
        let tab_id: Option<String> = None;
        let ids = ids![task_id, tab_id];
        assert_eq!(
            canonical_line("attach_terminal_tab", &ids, 2, None),
            "command=attach_terminal_tab task_id=MON-42 duration_ms=2 result=ok"
        );
    }

    #[test]
    fn a_multiline_error_stays_on_one_line() {
        let error = ApiError::storage("open failed\n  caused by: locked");
        let line = canonical_line("prepare_task", &Ids::default(), 9, Some(&error));
        assert!(!line.contains('\n'), "{line}");
        assert!(line.ends_with("message=\"open failed   caused by: locked\""), "{line}");
    }

    #[test]
    fn an_oversized_value_is_capped_and_marked() {
        let long = "x".repeat(MAX_MESSAGE + 10);
        let capped = field(&long, MAX_MESSAGE);
        assert_eq!(capped.chars().count(), MAX_MESSAGE + 1);
        assert!(capped.ends_with('…'));
    }

    #[test]
    fn an_embedded_quote_is_escaped_inside_the_quoted_value() {
        assert_eq!(field(r#"say "hi""#, 200), r#""say \"hi\"""#);
    }

    #[test]
    fn an_empty_value_is_quoted_so_the_key_is_still_readable() {
        assert_eq!(field("", 200), "\"\"");
    }
}
