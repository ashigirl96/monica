use crate::protocol::SegTranslation;

#[derive(Default)]
pub struct LineBuffer {
    buf: String,
}

impl LineBuffer {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push_delta(&mut self, text: &str) -> Vec<SegTranslation> {
        self.buf.push_str(text);
        let mut results = Vec::new();

        while let Some(pos) = self.buf.find('\n') {
            let line: String = self.buf.drain(..=pos).collect();
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            if is_fence_line(line) {
                continue;
            }
            match serde_json::from_str::<SegTranslation>(line) {
                Ok(st) => results.push(st),
                Err(e) => log::warn!("skip unparsable line: {e}: {line}"),
            }
        }

        results
    }

    pub fn flush(&mut self) -> Vec<SegTranslation> {
        let remaining = std::mem::take(&mut self.buf);
        let line = remaining.trim();
        if line.is_empty() || is_fence_line(line) {
            return vec![];
        }
        match serde_json::from_str::<SegTranslation>(line) {
            Ok(st) => vec![st],
            Err(e) => {
                log::warn!("skip unparsable final line: {e}: {line}");
                vec![]
            }
        }
    }
}

fn is_fence_line(line: &str) -> bool {
    let trimmed = line.trim();
    trimmed.starts_with("```")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_complete_line() {
        let mut buf = LineBuffer::new();
        let results =
            buf.push_delta("{\"seg\": 1, \"translation\": \"こんにちは\"}\n");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].seg, 1);
        assert_eq!(results[0].translation, "こんにちは");
    }

    #[test]
    fn buffers_incomplete_line() {
        let mut buf = LineBuffer::new();
        assert!(buf.push_delta("{\"seg\": 1, \"translat").is_empty());
        let results = buf.push_delta("ion\": \"hello\"}\n");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].seg, 1);
    }

    #[test]
    fn skips_broken_line() {
        let mut buf = LineBuffer::new();
        let results = buf.push_delta("not json at all\n");
        assert!(results.is_empty());
    }

    #[test]
    fn skips_fence_lines() {
        let mut buf = LineBuffer::new();
        let results = buf.push_delta("```jsonl\n{\"seg\":1,\"translation\":\"hi\"}\n```\n");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].seg, 1);
    }

    #[test]
    fn multiple_lines_at_once() {
        let mut buf = LineBuffer::new();
        let results = buf.push_delta(
            "{\"seg\":0,\"translation\":\"a\"}\n{\"seg\":1,\"translation\":\"b\"}\n",
        );
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].seg, 0);
        assert_eq!(results[1].seg, 1);
    }

    #[test]
    fn flush_final_line() {
        let mut buf = LineBuffer::new();
        assert!(buf.push_delta("{\"seg\":5,\"translation\":\"end\"}").is_empty());
        let results = buf.flush();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].seg, 5);
    }

    #[test]
    fn flush_empty() {
        let mut buf = LineBuffer::new();
        assert!(buf.flush().is_empty());
    }

    #[test]
    fn skips_empty_lines() {
        let mut buf = LineBuffer::new();
        let results = buf.push_delta("\n\n{\"seg\":0,\"translation\":\"ok\"}\n\n");
        assert_eq!(results.len(), 1);
    }
}
