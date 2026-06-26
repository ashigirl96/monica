/// Wraps `s` in single quotes so it survives as one literal POSIX shell word,
/// escaping any embedded single quote with the `'\''` idiom. The single source
/// of truth for command-line quoting across crates.
pub fn quote_single(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wraps_plain_text() {
        assert_eq!(quote_single("hello world"), "'hello world'");
    }

    #[test]
    fn escapes_embedded_single_quote() {
        assert_eq!(quote_single("a'b"), "'a'\\''b'");
    }
}
