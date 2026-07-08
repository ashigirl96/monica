use std::path::Path;

use anyhow::Result;

/// One record of a Claude Code transcript JSONL, reduced to what Monica surfaces.
/// Anything else (progress lines, summaries, unknown record types) parses as [`Other`]
/// so the cursor still advances past it.
///
/// [`Other`]: ClaudeTranscriptRecordKind::Other
#[derive(Debug, Clone, PartialEq)]
pub struct ClaudeTranscriptRecord {
    pub uuid: Option<String>,
    pub timestamp: Option<String>,
    pub kind: ClaudeTranscriptRecordKind,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ClaudeTranscriptRecordKind {
    Assistant {
        /// The concatenated text blocks of the message (empty for a pure tool-use message).
        text: String,
        tool_uses: Vec<ClaudeToolUse>,
    },
    User,
    Other,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ClaudeToolUse {
    pub id: String,
    pub name: String,
    pub input_json: String,
}

/// What one incremental read of the transcript yielded.
#[derive(Debug, Clone, PartialEq)]
pub struct TranscriptChunk {
    pub records: Vec<ClaudeTranscriptRecord>,
    /// The cursor after this read: end of the last complete (`\n`-terminated) line
    /// consumed. A partially-flushed trailing line is left for the next read.
    pub new_offset: u64,
    /// `false` while Claude has not created the file yet (it appears lazily on the first
    /// user message) — the cursor must stay put, not reset.
    pub file_exists: bool,
}

/// Incremental reader over a Claude Code session transcript (`~/.claude/projects/
/// <slug>/<session-id>.jsonl`, appended one JSON record per line). Claude owns the file;
/// Monica only ever reads from a byte offset it persisted.
pub trait ClaudeTranscriptReader {
    /// Read complete lines from `offset` to EOF. A file shorter than `offset` (an
    /// unexpected truncate) restarts from 0.
    fn read_from(&self, jsonl_path: &Path, offset: u64) -> Result<TranscriptChunk>;
}
