use std::fs::File;
use std::io::{ErrorKind, Read, Seek, SeekFrom};
use std::path::Path;

use anyhow::{Context, Result};
use serde_json::Value;

use monica_application::{
    ClaudeToolUse, ClaudeTranscriptReader, ClaudeTranscriptRecord, ClaudeTranscriptRecordKind,
    TranscriptChunk,
};

/// Incremental reader over Claude Code's session transcript JSONL. Claude appends one
/// JSON record per line; a record may be mid-flush when we read, so only `\n`-terminated
/// lines are consumed and the cursor never lands inside a line.
#[derive(Debug, Default, Clone, Copy)]
pub struct FsClaudeTranscriptReader;

impl ClaudeTranscriptReader for FsClaudeTranscriptReader {
    fn read_from(&self, jsonl_path: &Path, offset: u64) -> Result<TranscriptChunk> {
        let mut file = match File::open(jsonl_path) {
            Ok(file) => file,
            // Claude creates the file lazily on the first user message.
            Err(e) if e.kind() == ErrorKind::NotFound => {
                return Ok(TranscriptChunk {
                    records: Vec::new(),
                    new_offset: offset,
                    file_exists: false,
                });
            }
            Err(e) => {
                return Err(e)
                    .with_context(|| format!("failed to open {}", jsonl_path.display()))
            }
        };
        let len = file
            .metadata()
            .with_context(|| format!("failed to stat {}", jsonl_path.display()))?
            .len();
        // Shorter than the cursor means the file is not the one we were reading
        // (an unexpected truncate/replace) — restart rather than read garbage.
        let start = if len < offset { 0 } else { offset };
        file.seek(SeekFrom::Start(start))?;
        let mut buf = Vec::new();
        file.read_to_end(&mut buf)
            .with_context(|| format!("failed to read {}", jsonl_path.display()))?;

        let consumed = match buf.iter().rposition(|&b| b == b'\n') {
            Some(last_newline) => last_newline + 1,
            None => 0,
        };
        let records = buf[..consumed]
            .split(|&b| b == b'\n')
            .filter(|line| !line.iter().all(u8::is_ascii_whitespace))
            .map(parse_record)
            .collect();
        Ok(TranscriptChunk {
            records,
            new_offset: start + consumed as u64,
            file_exists: true,
        })
    }
}

/// One transcript line → record. Unparseable or unknown lines become `Other` — the cursor
/// must advance past them, never wedge on them.
fn parse_record(line: &[u8]) -> ClaudeTranscriptRecord {
    let Ok(parsed) = serde_json::from_slice::<Value>(line) else {
        return ClaudeTranscriptRecord {
            uuid: None,
            timestamp: None,
            kind: ClaudeTranscriptRecordKind::Other,
        };
    };
    let text_of = |value: &Value, key: &str| {
        value.get(key).and_then(Value::as_str).map(str::to_string)
    };
    let kind = match parsed.get("type").and_then(Value::as_str) {
        Some("assistant") => assistant_kind(&parsed),
        Some("user") => ClaudeTranscriptRecordKind::User,
        _ => ClaudeTranscriptRecordKind::Other,
    };
    ClaudeTranscriptRecord {
        uuid: text_of(&parsed, "uuid"),
        timestamp: text_of(&parsed, "timestamp"),
        kind,
    }
}

fn assistant_kind(record: &Value) -> ClaudeTranscriptRecordKind {
    let blocks = record
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array);
    let mut text_parts: Vec<&str> = Vec::new();
    let mut tool_uses = Vec::new();
    for block in blocks.into_iter().flatten() {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(text) = block.get("text").and_then(Value::as_str) {
                    text_parts.push(text);
                }
            }
            Some("tool_use") => {
                tool_uses.push(ClaudeToolUse {
                    id: block
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    name: block
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    input_json: block
                        .get("input")
                        .map(Value::to_string)
                        .unwrap_or_else(|| "{}".to_string()),
                });
            }
            _ => {}
        }
    }
    ClaudeTranscriptRecordKind::Assistant {
        text: text_parts.join("\n"),
        tool_uses,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_jsonl(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "monica-transcript-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("session.jsonl");
        let _ = std::fs::remove_file(&path);
        path
    }

    fn read(path: &Path, offset: u64) -> TranscriptChunk {
        FsClaudeTranscriptReader.read_from(path, offset).unwrap()
    }

    #[test]
    fn missing_file_reports_not_existing_and_keeps_the_cursor() {
        let path = temp_jsonl("missing");
        let chunk = read(&path, 7);
        assert!(!chunk.file_exists);
        assert!(chunk.records.is_empty());
        assert_eq!(chunk.new_offset, 7, "a lazy-created file must not reset the cursor");
    }

    #[test]
    fn parses_assistant_text_and_tool_uses() {
        let path = temp_jsonl("assistant");
        let line = serde_json::json!({
            "type": "assistant",
            "uuid": "r-1",
            "timestamp": "2026-07-06T00:00:00.000Z",
            "message": {"content": [
                {"type": "text", "text": "hello"},
                {"type": "tool_use", "id": "t-1", "name": "Bash", "input": {"command": "ls"}},
                {"type": "text", "text": "done"}
            ]}
        });
        std::fs::write(&path, format!("{line}\n")).unwrap();

        let chunk = read(&path, 0);

        assert!(chunk.file_exists);
        assert_eq!(chunk.records.len(), 1);
        assert_eq!(chunk.records[0].uuid.as_deref(), Some("r-1"));
        let ClaudeTranscriptRecordKind::Assistant { text, tool_uses } = &chunk.records[0].kind
        else {
            panic!("expected assistant record, got {:?}", chunk.records[0].kind)
        };
        assert_eq!(text, "hello\ndone");
        assert_eq!(tool_uses.len(), 1);
        assert_eq!(tool_uses[0].name, "Bash");
        assert_eq!(tool_uses[0].input_json, r#"{"command":"ls"}"#);
        assert_eq!(chunk.new_offset, std::fs::metadata(&path).unwrap().len());
    }

    #[test]
    fn partial_trailing_line_is_left_for_the_next_read() {
        let path = temp_jsonl("partial");
        let complete = r#"{"type":"user","uuid":"u-1"}"#;
        std::fs::write(&path, format!("{complete}\n{{\"type\":\"assist")).unwrap();

        let chunk = read(&path, 0);

        assert_eq!(chunk.records.len(), 1);
        assert_eq!(chunk.records[0].kind, ClaudeTranscriptRecordKind::User);
        assert_eq!(chunk.new_offset, (complete.len() + 1) as u64);

        // Completing the line later resumes exactly where the cursor stopped.
        let mut file = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(b"ant\",\"message\":{\"content\":[]}}\n").unwrap();
        let next = read(&path, chunk.new_offset);
        assert_eq!(next.records.len(), 1);
        assert!(matches!(
            next.records[0].kind,
            ClaudeTranscriptRecordKind::Assistant { .. }
        ));
    }

    #[test]
    fn unknown_and_unparseable_lines_become_other_and_advance_the_cursor() {
        let path = temp_jsonl("unknown");
        std::fs::write(
            &path,
            "{\"type\":\"summary\",\"uuid\":\"s-1\"}\nnot json at all\n",
        )
        .unwrap();

        let chunk = read(&path, 0);

        assert_eq!(chunk.records.len(), 2);
        assert!(chunk
            .records
            .iter()
            .all(|r| r.kind == ClaudeTranscriptRecordKind::Other));
        assert_eq!(chunk.new_offset, std::fs::metadata(&path).unwrap().len());
    }

    #[test]
    fn truncated_file_restarts_from_zero() {
        let path = temp_jsonl("truncated");
        std::fs::write(&path, "{\"type\":\"user\"}\n").unwrap();
        let len = std::fs::metadata(&path).unwrap().len();

        let chunk = read(&path, len + 100);

        assert_eq!(chunk.records.len(), 1, "must re-read from the start");
        assert_eq!(chunk.new_offset, len);
    }
}
