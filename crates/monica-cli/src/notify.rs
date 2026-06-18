use monica_core::TaskRunWaitReason;

const TITLE: &str = "Monica";
const MAX_TITLE_CHARS: usize = 40;

pub struct Notification {
    title: String,
    body: String,
}

/// Build the notification for a run that just entered `WaitingForUser`. The caller gates on the
/// entering edge, so this always produces a notification; the wait reason only shapes the wording.
pub fn waiting_notification(
    wait_reason: Option<TaskRunWaitReason>,
    task_title: Option<&str>,
) -> Notification {
    let reason = match wait_reason {
        Some(TaskRunWaitReason::ExitPlanMode) => "プラン承認待ち",
        Some(TaskRunWaitReason::AskUserQuestion) => "質問への回答待ち",
        Some(TaskRunWaitReason::AwaitingPrompt) | None => "入力待ち",
    };
    let body = match task_title {
        Some(title) if !title.is_empty() => format!("「{}」が{reason}", truncate(title, MAX_TITLE_CHARS)),
        _ => reason.to_string(),
    };
    Notification {
        title: TITLE.to_string(),
        body,
    }
}

fn truncate(s: &str, max_chars: usize) -> String {
    let mut chars = s.chars();
    let head: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{head}…")
    } else {
        head
    }
}

/// Escape a Rust string for embedding inside an AppleScript double-quoted literal.
fn applescript_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Fire a macOS notification via `osascript`. Best-effort: the result is ignored so a failed
/// notification never disrupts the hook (see `hook::handle_claude`).
#[cfg(target_os = "macos")]
pub fn post(n: &Notification) {
    let script = format!(
        "display notification \"{}\" with title \"{}\"",
        applescript_escape(&n.body),
        applescript_escape(&n.title),
    );
    let _ = std::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .status();
}

#[cfg(not(target_os = "macos"))]
pub fn post(_: &Notification) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn body_varies_by_wait_reason() {
        assert_eq!(
            waiting_notification(Some(TaskRunWaitReason::ExitPlanMode), None).body,
            "プラン承認待ち"
        );
        assert_eq!(
            waiting_notification(Some(TaskRunWaitReason::AskUserQuestion), None).body,
            "質問への回答待ち"
        );
        assert_eq!(
            waiting_notification(Some(TaskRunWaitReason::AwaitingPrompt), None).body,
            "入力待ち"
        );
        assert_eq!(waiting_notification(None, None).body, "入力待ち");
    }

    #[test]
    fn body_includes_task_title_when_present() {
        let n = waiting_notification(Some(TaskRunWaitReason::ExitPlanMode), Some("ログイン修正"));
        assert_eq!(n.body, "「ログイン修正」がプラン承認待ち");
        assert_eq!(n.title, "Monica");
    }

    #[test]
    fn empty_title_is_treated_as_absent() {
        let n = waiting_notification(None, Some(""));
        assert_eq!(n.body, "入力待ち");
    }

    #[test]
    fn title_at_exact_limit_is_not_truncated() {
        let title = "あ".repeat(MAX_TITLE_CHARS);
        let n = waiting_notification(None, Some(&title));
        assert_eq!(n.body, format!("「{title}」が入力待ち"));
    }

    #[test]
    fn long_title_is_truncated_with_ellipsis() {
        let title = "あ".repeat(MAX_TITLE_CHARS + 5);
        let n = waiting_notification(None, Some(&title));
        let expected = format!("「{}…」が入力待ち", "あ".repeat(MAX_TITLE_CHARS));
        assert_eq!(n.body, expected);
    }

    #[test]
    fn applescript_escape_handles_quotes_and_backslashes() {
        assert_eq!(applescript_escape(r#"a"b"#), r#"a\"b"#);
        assert_eq!(applescript_escape(r"a\b"), r"a\\b");
        // Backslash escaping runs first so a literal `\"` does not collapse into one escape.
        assert_eq!(applescript_escape(r#"\""#), r#"\\\""#);
    }
}
