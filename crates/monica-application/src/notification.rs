use monica_domain::TaskRunWaitReason;

pub const TITLE: &str = "Monica";
const MAX_TITLE_CHARS: usize = 40;

pub fn awaiting_user_input_dedupe_key(
    run_id: Option<&str>,
    session_id: Option<&str>,
) -> Option<String> {
    run_id
        .map(|id| format!("awaiting_user_input:{id}"))
        .or_else(|| session_id.map(|id| format!("awaiting_user_input:session:{id}")))
}

pub fn waiting_notification(
    wait_reason: Option<TaskRunWaitReason>,
    task_title: Option<&str>,
) -> String {
    let reason = match wait_reason {
        Some(TaskRunWaitReason::ExitPlanMode) => "プラン承認待ち",
        Some(TaskRunWaitReason::AskUserQuestion) => "質問への回答待ち",
        Some(TaskRunWaitReason::PermissionRequest) => "パーミッション承認待ち",
        Some(TaskRunWaitReason::AwaitingPrompt) | None => "入力待ち",
    };
    match task_title {
        Some(title) if !title.is_empty() => {
            format!("「{}」が{reason}", truncate(title, MAX_TITLE_CHARS))
        }
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
}
