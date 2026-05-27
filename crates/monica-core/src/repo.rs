use anyhow::{anyhow, Result};

/// Extract `owner/repo` from a git remote URL. Handles scp-like (`git@github.com:owner/repo.git`),
/// https, and ssh:// forms, plus trailing `.git` / `/`. Host is not validated (non-GitHub
/// providers are out of scope); only the last two path segments matter. The result is lowercased
/// because GitHub repo names are case-insensitive, so the registry key must match regardless of
/// the casing the caller typed.
pub fn parse_owner_repo(url: &str) -> Result<String> {
    let s = url.trim();
    let s = ["ssh://", "https://", "http://", "git://"]
        .iter()
        .find_map(|scheme| s.strip_prefix(scheme))
        .unwrap_or(s);
    let s = s.replace(':', "/");
    let s = s.trim_end_matches('/');
    let s = s.strip_suffix(".git").unwrap_or(s);

    let parts: Vec<&str> = s.split('/').filter(|p| !p.is_empty()).collect();
    if parts.len() < 2 {
        return Err(anyhow!(
            "could not parse owner/repo from git remote {url:?}"
        ));
    }
    Ok(format!("{}/{}", parts[parts.len() - 2], parts[parts.len() - 1]).to_lowercase())
}

/// Parse an issue reference `owner/repo#123`. The left side is normalized with
/// [`parse_owner_repo`]; the right side must be a positive integer issue number.
pub fn parse_issue_ref(target: &str) -> Result<(String, i64)> {
    let (repo_part, number_part) = target
        .trim()
        .split_once('#')
        .ok_or_else(|| anyhow!("expected owner/repo#number, got {target:?}"))?;
    let repo = parse_owner_repo(repo_part)?;
    let number: i64 = number_part
        .trim()
        .parse()
        .map_err(|_| anyhow!("issue number must be a positive integer, got {number_part:?}"))?;
    if number <= 0 {
        return Err(anyhow!(
            "issue number must be a positive integer, got {number}"
        ));
    }
    Ok((repo, number))
}

#[cfg(test)]
mod tests {
    use super::{parse_issue_ref, parse_owner_repo};

    #[test]
    fn parses_common_remote_forms() {
        let cases = [
            "git@github.com:ashigirl96/monica.git",
            "git@github.com:ashigirl96/monica",
            "https://github.com/ashigirl96/monica.git",
            "https://github.com/ashigirl96/monica",
            "https://github.com/ashigirl96/monica/",
            "ssh://git@github.com/ashigirl96/monica.git",
            "  https://github.com/ashigirl96/monica.git\n",
            "ashigirl96/monica",
            "ashigirl96/monica/",
        ];
        for case in cases {
            assert_eq!(
                parse_owner_repo(case).unwrap(),
                "ashigirl96/monica",
                "{case}"
            );
        }
    }

    #[test]
    fn rejects_unparseable_remote() {
        assert!(parse_owner_repo("not-a-url").is_err());
        assert!(parse_owner_repo("").is_err());
    }

    #[test]
    fn parse_owner_repo_lowercases_case_insensitive_names() {
        assert_eq!(
            parse_owner_repo("AshiGirl96/Monica").unwrap(),
            "ashigirl96/monica"
        );
        assert_eq!(
            parse_owner_repo("git@github.com:AshiGirl96/Monica.git").unwrap(),
            "ashigirl96/monica"
        );
    }

    #[test]
    fn parses_issue_ref_forms() {
        assert_eq!(
            parse_issue_ref("ashigirl96/monica#9").unwrap(),
            ("ashigirl96/monica".to_string(), 9)
        );
        assert_eq!(
            parse_issue_ref("  https://github.com/ashigirl96/monica#42  ").unwrap(),
            ("ashigirl96/monica".to_string(), 42)
        );
        assert_eq!(
            parse_issue_ref("AshiGirl96/Monica#9").unwrap(),
            ("ashigirl96/monica".to_string(), 9)
        );
    }

    #[test]
    fn rejects_bad_issue_ref() {
        assert!(parse_issue_ref("ashigirl96/monica").is_err(), "missing #");
        assert!(
            parse_issue_ref("ashigirl96/monica#abc").is_err(),
            "non-numeric"
        );
        assert!(parse_issue_ref("ashigirl96/monica#0").is_err(), "zero");
        assert!(parse_issue_ref("ashigirl96/monica#-3").is_err(), "negative");
        assert!(parse_issue_ref("#5").is_err(), "missing owner/repo");
        assert!(parse_issue_ref("").is_err(), "empty");
    }
}
