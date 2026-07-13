pub fn check_origin(origin: Option<&str>, allowed: &[String]) -> bool {
    let Some(origin) = origin else {
        return false;
    };
    let origin = origin.trim_end_matches('/');
    allowed.iter().any(|a| a.trim_end_matches('/') == origin)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_matching_extension_origin() {
        let allowed = vec!["chrome-extension://abcdef123456".to_string()];
        assert!(check_origin(
            Some("chrome-extension://abcdef123456"),
            &allowed
        ));
    }

    #[test]
    fn accepts_with_trailing_slash() {
        let allowed = vec!["chrome-extension://abcdef123456".to_string()];
        assert!(check_origin(
            Some("chrome-extension://abcdef123456/"),
            &allowed
        ));
    }

    #[test]
    fn rejects_missing_origin() {
        let allowed = vec!["chrome-extension://abcdef123456".to_string()];
        assert!(!check_origin(None, &allowed));
    }

    #[test]
    fn rejects_wrong_origin() {
        let allowed = vec!["chrome-extension://abcdef123456".to_string()];
        assert!(!check_origin(Some("https://evil.example.com"), &allowed));
    }

    #[test]
    fn rejects_empty_allowlist() {
        assert!(!check_origin(
            Some("chrome-extension://abcdef123456"),
            &[]
        ));
    }

    #[test]
    fn accepts_one_of_many() {
        let allowed = vec![
            "chrome-extension://aaa".to_string(),
            "chrome-extension://bbb".to_string(),
        ];
        assert!(check_origin(Some("chrome-extension://bbb"), &allowed));
    }
}
