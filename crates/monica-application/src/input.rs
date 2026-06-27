use monica_domain::{parse_issue_number, parse_issue_ref, parse_owner_repo, DomainError};

/// Accept what a user pastes to track an issue: a GitHub issue URL
/// (`https://github.com/owner/repo/issues/9`, query/fragment tolerated) or an `owner/repo#9` ref.
///
/// This is user-input interpretation, so it sits at the application boundary rather than in the
/// domain; it composes the domain's identity/format primitives ([`parse_owner_repo`],
/// [`parse_issue_ref`], [`parse_issue_number`]).
pub fn parse_issue_input(input: &str) -> Result<(String, i64), DomainError> {
    let s = input.trim();
    if let Some((repo_part, rest)) = s.split_once("/issues/") {
        let number_part = rest.split(['/', '?', '#']).next().unwrap_or(rest);
        let number = parse_issue_number(number_part)?;
        return Ok((parse_owner_repo(repo_part)?, number));
    }
    parse_issue_ref(s)
}

#[cfg(test)]
mod tests {
    use super::parse_issue_input;

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
}
