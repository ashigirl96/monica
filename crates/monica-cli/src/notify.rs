use monica_core::TaskRunWaitReason;

const TITLE: &str = "Monica";
const MAX_TITLE_CHARS: usize = 40;

/// Build the notification body for a run that just entered `WaitingForUser`. The caller gates on
/// the entering edge, so this always produces a body; the wait reason only shapes the wording.
pub fn waiting_notification(wait_reason: Option<TaskRunWaitReason>, task_title: Option<&str>) -> String {
    let reason = match wait_reason {
        Some(TaskRunWaitReason::ExitPlanMode) => "プラン承認待ち",
        Some(TaskRunWaitReason::AskUserQuestion) => "質問への回答待ち",
        Some(TaskRunWaitReason::AwaitingPrompt) | None => "入力待ち",
    };
    match task_title {
        Some(title) if !title.is_empty() => format!("「{}」が{reason}", truncate(title, MAX_TITLE_CHARS)),
        _ => reason.to_string(),
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

/// Fire a macOS notification via `osascript`. Best-effort and fire-and-forget: the child is not
/// waited on so a notification never adds latency to (nor can disrupt) the hook.
#[cfg(target_os = "macos")]
pub fn post(body: &str) {
    let script = format!(
        "display notification \"{}\" with title \"{}\"",
        applescript_escape(body),
        applescript_escape(TITLE),
    );
    let _ = std::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .spawn();
}

#[cfg(not(target_os = "macos"))]
pub fn post(_: &str) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn body_varies_by_wait_reason() {
        assert_eq!(
            waiting_notification(Some(TaskRunWaitReason::ExitPlanMode), None),
            "プラン承認待ち"
        );
        assert_eq!(
            waiting_notification(Some(TaskRunWaitReason::AskUserQuestion), None),
            "質問への回答待ち"
        );
        assert_eq!(
            waiting_notification(Some(TaskRunWaitReason::AwaitingPrompt), None),
            "入力待ち"
        );
        assert_eq!(waiting_notification(None, None), "入力待ち");
    }

    #[test]
    fn body_includes_task_title_when_present() {
        assert_eq!(
            waiting_notification(Some(TaskRunWaitReason::ExitPlanMode), Some("ログイン修正")),
            "「ログイン修正」がプラン承認待ち"
        );
    }

    #[test]
    fn empty_title_is_treated_as_absent() {
        assert_eq!(waiting_notification(None, Some("")), "入力待ち");
    }

    #[test]
    fn title_at_exact_limit_is_not_truncated() {
        let title = "あ".repeat(MAX_TITLE_CHARS);
        assert_eq!(
            waiting_notification(None, Some(&title)),
            format!("「{title}」が入力待ち")
        );
    }

    #[test]
    fn long_title_is_truncated_with_ellipsis() {
        let title = "あ".repeat(MAX_TITLE_CHARS + 5);
        assert_eq!(
            waiting_notification(None, Some(&title)),
            format!("「{}…」が入力待ち", "あ".repeat(MAX_TITLE_CHARS))
        );
    }

    #[test]
    fn applescript_escape_handles_quotes_and_backslashes() {
        assert_eq!(applescript_escape(r#"a"b"#), r#"a\"b"#);
        assert_eq!(applescript_escape(r"a\b"), r"a\\b");
        // Backslash escaping runs first so a literal `\"` does not collapse into one escape.
        assert_eq!(applescript_escape(r#"\""#), r#"\\\""#);
    }
}
