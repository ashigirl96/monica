---
name: explain
description: Creates a Monica explanation entry via `monica explain new` and writes a rich, interactive HTML explanation of a code change into the explanations directory.
disable-model-invocation: true
---

# Explain

Please make me a rich, interactive explanation of the specified code change.

## Workflow

1. **Understand the change** — Identify what to explain (the working diff, the current branch against the default branch, or a specific PR/range) and study it. Broadly explore the surrounding code too; the Background section depends on it.

2. **Decide a title and summary** — Choose a short, plain-text title that names the change (e.g. `Session store refactor into adapters`). It becomes the explanation's title in Monica and the HTML `<title>`. Also compose a 1–2 sentence plain-text summary of what the change does — this appears on the explanation list card and helps recall without opening the full document. Avoid characters that need shell escaping (quotes, backticks, `$`, backslash) in both.

3. **Create the explanation entry** — Run:

   ```bash
   "${MONICA_BIN:-monica}" explain new --mode diff --title "<title>" --summary "<summary>"
   ```

   - On success, stdout is exactly one line: the absolute path of the scaffolded `index.html` (for example `/Users/you/monica/explanations/expl-12/index.html`). Human-facing messages go to stderr. Use this literal path in every following step.
   - The explanation id is the name of the directory containing `index.html` — `expl-12` in the example above.
   - If the command exits non-zero, stop and report its error output verbatim. The usual cause is running outside a Monica terminal (`MONICA_TERMINAL_SESSION_ID` is unset). Do not fall back to writing the HTML anywhere else — output to `/tmp` is retired.

4. **Read the scaffold** — Read the `index.html` at that path. It is a bare HTML fragment: `<meta>` tags, a `<title>`, and a small `<style>` block, ending with this marker line:

   ```html
   <!-- Preserve the head above; replace the body below. -->
   ```

5. **Compose and write** — Author the explanation following the Sections and Format rules below, then Write the complete file back to the same path.

   - The written file MUST begin with the scaffold exactly as you read it — every line up to and including the marker comment, byte for byte.
   - Everything you author goes below the marker comment. Do not edit, reorder, or duplicate the scaffold's `<meta>`, `<title>`, or `<style>`; add your own CSS and JavaScript in new `<style>` / `<script>` blocks after the marker.

6. **Verify** — Re-read the top of the written file and confirm the scaffold lines and the marker comment are intact, and check each code block against the Format rules below.

7. **Deliver** — Run: `!open "$MONICA_WEB_URL/explanations/<id>/`

## Sections

It should have these sections:

- Background: Explain the existing system relevant to this change. (You should broadly explore surrounding code for this.) We don't know how much the reader already knows, so include a deep background for beginners (note that it can be skipped if the reader is already familiar), and then a more narrow background directly relevant to the change.
- Intuition: Explain the core intuition for the code change. The focus here is to explain the essence, not the full details. Use concrete examples with toy data. Use figures and diagrams liberally.
- Code: Do a high-level walkthrough of the changes to the code. Group/order the changes in an understandable way.
- Quiz: Come up with five questions that test the reader's knowledge of this PR. This should be medium difficulty, difficult enough that you actually need to understand the substance of the PR to answer them, but not gotchas. The goal is to help the reader make sure that they've actually understood. These should be presented as interactive multiple-choice questions, and when the user clicks, it tells them whether they were correct and gives feedback.

## Format

- Output a single self-contained HTML file which includes CSS and JavaScript. Make the whole thing one long page with section headers and a table of contents. Don't use tabs for the top-level structure. Basic responsive styling so you can view it on a phone is nice too.
- Please write with the clarity and flow of Martin Kleppmann, making it engaging and written in classic style. Transitions between sections should be smooth.
- Some tips on diagrams. Ideally, you should pick a small number of diagram families that can be reused throughout the explanation to explain various cases. Some useful kinds of diagrams:
  - A very simplified version of the UI that the user sees in the app, to explain UI changes.
  - A system diagram showing data flow or communication between components. Make sure to include example data here!
- Don't use ASCII diagrams. Always use simple HTML designs for your diagrams, HTML lists for lists of things, etc.
  - For code blocks, always use `<pre>` tags. If you use a custom styled div instead, it **must** have
    `white-space: pre-wrap` in its CSS, or the browser will collapse all newlines into a single line.
    Before saving the file, scan each code block in the HTML source and confirm its CSS includes
    `white-space: pre` or `pre-wrap`.
- Use callouts for key concepts or definitions, important edge cases, etc.
