---
name: codex
description: Use Codex CLI directly to generate design documents, implementation plans, or reviews from issue specs and local files. Trigger this skill when the user asks to draft a design/plan with Codex, critique an existing draft, or run a structured Codex prompt.
---

# Codex CLI

Use local `codex` CLI.

## Result Contract

Claude Code に返すのは **Codex の最終メッセージだけ** にする。

- `codex exec` の標準出力イベント列や途中経過を、そのまま会話へ貼り付けない
- 既定では `--output-last-message <tmp-file>` を使って最終結果を別ファイルへ落とす
- コマンド本体の stdout / stderr はログファイルへ逃がし、必要なときだけ失敗調査に使う
- Claude Code 側では最終メッセージの要点だけを返し、中間 session の軌跡は返さない
- 失敗時だけ、ログの末尾から必要最小限の stderr を確認して原因を判断する

## Quick Start

Run single-line prompt:

```bash
tmp="$(mktemp)"
log="$(mktemp)"
codex exec -o "$tmp" "Summarize the architectural risks in this issue: <issue text>" \
  >"$log" 2>&1
cat "$tmp"
```

Run structured prompt from stdin (recommended for non-trivial tasks):

```bash
tmp="$(mktemp)"
log="$(mktemp)"
cat <<'EOF' | codex exec -o "$tmp" - >"$log" 2>&1
<instructions>
Generate a concise design document from the issue below.
Follow existing patterns in this repository.
</instructions>

<issue>
<paste issue title/body here>
</issue>
EOF
cat "$tmp"
```

## Prompt Pattern

Keep prompts explicit and separate instruction from context:

```xml
<instructions>
Task, constraints, output format, and review criteria.
</instructions>

<context>
Issue text, draft document, or file excerpts.
</context>
```

Use this default output contract unless user specifies another:

- Markdown only
- Findings first for review tasks
- No unnecessary preamble
- Final answer only; never relay the raw Codex event stream

## Common Workflows

Generate design from issue text:

```bash
tmp="$(mktemp)"
log="$(mktemp)"
cat <<'EOF' | codex exec -o "$tmp" - >"$log" 2>&1
<instructions>
Create one design document in Markdown.
Prioritize correctness, constraints, and migration risk.
</instructions>

<issue>
<issue body>
</issue>
EOF
cat "$tmp"
```

Review an existing draft against an issue:

```bash
tmp="$(mktemp)"
log="$(mktemp)"
cat <<'EOF' | codex exec -o "$tmp" - >"$log" 2>&1
<instructions>
Review <draft> against <issue>. Report only critical gaps or contradictions.
</instructions>

<issue>
<issue body>
</issue>

<draft>
<draft markdown>
</draft>
EOF
cat "$tmp"
```

Reference local file content:

```bash
tmp="$(mktemp)"
log="$(mktemp)"
cat <<EOF | codex exec -o "$tmp" - >"$log" 2>&1
<instructions>
Review the draft in <draft> against the issue requirements in <issue>.
</instructions>

<issue>
$(cat /absolute/path/to/issue.md)
</issue>

<draft>
$(cat /absolute/path/to/draft.md)
</draft>
EOF
cat "$tmp"
```

Use unquoted heredoc (`<<EOF`) only when expansion like `$(cat ...)` is required.

## Operational Notes

- Keep runs in foreground and wait for output.
- If prompt is long, always use stdin piping rather than long inline arguments.
- Re-run with a tighter prompt if output drifts from requested format.
- On success, read from the `--output-last-message` file, not from captured stdout.
- On failure, inspect the log file first and only surface the minimum stderr lines needed to explain the failure.
