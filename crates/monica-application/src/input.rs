use monica_domain::{parse_issue_number, parse_issue_ref, parse_owner_repo, DomainError};

/// Accept what a user pastes to track an issue: a GitHub issue URL
/// (`https://github.com/owner/repo/issues/9`, query/fragment tolerated) or an `owner/repo#9` ref.
///
/// This is user-input interpretation, so it sits at the application boundary rather than in the
/// domain; it composes the domain's identity/format primitives ([`parse_owner_repo`],
/// [`parse_issue_ref`], [`parse_issue_number`]).
pub fn parse_issue_input(input: &str) -> Result<(String, i64), DomainError> {
    parse_repo_item_input(input, "/issues/")
}

/// The pull-request twin of [`parse_issue_input`]: a GitHub PR URL
/// (`https://github.com/owner/repo/pull/9`) or an `owner/repo#9` ref. A URL for the other kind
/// falls through to the ref form and is rejected there, so an issue link cannot be filed as a PR.
pub fn parse_pull_request_input(input: &str) -> Result<(String, i64), DomainError> {
    parse_repo_item_input(input, "/pull/")
}

fn parse_repo_item_input(input: &str, url_segment: &str) -> Result<(String, i64), DomainError> {
    let s = input.trim();
    if let Some((repo_part, rest)) = s.split_once(url_segment) {
        let number_part = rest.split(['/', '?', '#']).next().unwrap_or(rest);
        let number = parse_issue_number(number_part)?;
        return Ok((parse_owner_repo(repo_part)?, number));
    }
    parse_issue_ref(s)
}

#[cfg(test)]
mod tests {
    use super::{parse_issue_input, parse_pull_request_input};

    #[test]
    fn parses_issue_input_url_and_ref_forms() {
        let cases = [
            "https://github.com/ashigirl96/monica/issues/9",
            "https://github.com/ashigirl96/monica/issues/9/",
            "https://github.com/ashigirl96/monica/issues/9?ref=foo",
            "https://github.com/AshiGirl96/Monica/issues/9#issuecomment-1",
            "  github.com/ashigirl96/monica/issues/9  ",
            "ashigirl96/monica#9",
        ];
        for case in cases {
            assert_eq!(
                parse_issue_input(case).unwrap(),
                ("ashigirl96/monica".to_string(), 9),
                "{case}"
            );
        }
    }

    #[test]
    fn rejects_bad_issue_input() {
        assert!(parse_issue_input("https://github.com/a/b/issues/abc").is_err());
        assert!(parse_issue_input("https://github.com/a/b/issues/0").is_err());
        assert!(parse_issue_input("ashigirl96/monica").is_err());
        assert!(parse_issue_input("").is_err());
    }

    #[test]
    fn parses_pull_request_input_url_and_ref_forms() {
        let cases = [
            "https://github.com/ashigirl96/monica/pull/9",
            "https://github.com/ashigirl96/monica/pull/9/files",
            "https://github.com/ashigirl96/monica/pull/9?w=1",
            "https://github.com/AshiGirl96/Monica/pull/9#issuecomment-1",
            "  github.com/ashigirl96/monica/pull/9  ",
            "ashigirl96/monica#9",
        ];
        for case in cases {
            assert_eq!(
                parse_pull_request_input(case).unwrap(),
                ("ashigirl96/monica".to_string(), 9),
                "{case}"
            );
        }
    }

    #[test]
    fn rejects_bad_pull_request_input() {
        assert!(parse_pull_request_input("https://github.com/a/b/pull/abc").is_err());
        assert!(parse_pull_request_input("https://github.com/a/b/pull/0").is_err());
        // An issue URL carries no `#`, so it cannot be mistaken for a PR ref.
        assert!(parse_pull_request_input("https://github.com/a/b/issues/9").is_err());
        assert!(parse_pull_request_input("").is_err());
    }
}
