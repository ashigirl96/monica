---
name: codex
description: Use Codex CLI directly to generate design documents, implementation plans, or reviews from issue specs and local files. Trigger this skill when the user asks to draft a design/plan with Codex, critique an existing draft, or run a structured Codex prompt.
---

# Codex CLI

Use local `codex` CLI.

## Quick Start

Run single-line prompt:

```bash
codex exec "Summarize the architectural risks in this issue: <issue text>"
```

Run structured prompt from stdin (recommended for non-trivial tasks):

```bash
cat <<'EOF' | codex exec -
<instructions>
Generate a concise design document from the issue below.
Follow existing patterns in this repository.
</instructions>

<issue>
<paste issue title/body here>
</issue>
EOF
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

## Common Workflows

Generate design from issue text:

```bash
cat <<'EOF' | codex exec -
<instructions>
Create one design document in Markdown.
Prioritize correctness, constraints, and migration risk.
</instructions>

<issue>
<issue body>
</issue>
EOF
```

Review an existing draft against an issue:

```bash
cat <<'EOF' | codex exec -
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
```

Reference local file content:

```bash
cat <<EOF | codex exec -
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
```

Use unquoted heredoc (`<<EOF`) only when expansion like `$(cat ...)` is required.

## Operational Notes

- Keep runs in foreground and wait for output.
- If prompt is long, always use stdin piping rather than long inline arguments.
- Re-run with a tighter prompt if output drifts from requested format.
