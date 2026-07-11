---
name: explain
description: Create a rich, self-contained HTML explainer for a topic and register it in Monica.
argument-hint: "<topic or question>"
disable-model-invocation: true
---

# Explain

Create an explanation that helps the reader participate in the next design conversation, not merely verify facts. The topic may be code, architecture, a concept, or any other subject; do not assume there is a diff.

## Steps

### 1. Register the explanation

Derive a concise, human-readable `TITLE` from the request without using tools. The first tool operation must run the following in one shell call, with `TITLE` set to the derived title:

```bash
TITLE='Session storage'
EXPLANATION_DIR="$(monica explain new "$TITLE")"
```

Replace the example title with the derived title and shell-quote it safely.

Treat stdout as the artifact directory. It must be one non-empty absolute path, and that directory must already exist. Record the literal path for later tool calls; do not assume the shell variable persists.

If the command fails or the path is invalid, stop and report the error. Do not create the directory yourself and do not fall back to `/tmp` or another location.

**Done when:** `monica explain new` succeeded and returned an existing absolute directory.

### 2. Build the mental model

Explore the sources needed to explain the topic accurately. For repository topics, inspect the current implementation and its surrounding system broadly. Use a diff only when the requested topic is a change. For other topics, inspect the relevant primary material rather than inventing a code-centered framing.

State a one-sentence learning goal, then identify the concepts and examples the reader needs to reach it. Prefer a problem-to-understanding arc.

**Done when:** the learning goal and every important claim are grounded in inspected sources.

### 3. Design the explanation

Use this adaptable structure:

- **Background:** broad beginner-friendly context followed by the narrower context required for this topic.
- **Intuition:** the essence before details, using concrete examples, toy data, and a small reusable family of figures.
- **Mechanics or guided tour:** explain how the subject works in a sensible order. For a code change, make this a literate walkthrough rather than a file-order diff.
- **Participation:** surface boundaries, tradeoffs, alternatives, transferable patterns, and questions that help the reader decide what to explore or change next.
- **Quiz:** five medium-difficulty multiple-choice questions. Avoid gotchas; each answer must reveal whether it is correct and explain why.

Write clear, rigorous, engaging technical prose with smooth transitions. Do not add sections mechanically when combining them produces a clearer narrative, but preserve all five functions above.

**Done when:** the outline reaches the learning goal without unexplained prerequisites and leaves the reader with concrete next questions.

### 4. Build a self-contained HTML artifact

Write the complete document to a temporary file inside `EXPLANATION_DIR`, not directly to `index.html`. The final artifact must be one long responsive page with a table of contents.

- Keep all authored CSS and JavaScript inline. Normal source links are allowed, but do not depend on external stylesheets, scripts, fonts, images, or other network assets.
- Use semantic HTML diagrams or inline SVG rather than ASCII diagrams. Reuse a small number of diagram families and include example data where useful.
- Use `<pre>` for code blocks. Its CSS must specify `white-space: pre` or `pre-wrap`.
- Use callouts for key concepts, definitions, and important edge cases.
- Implement the five-question quiz with inline JavaScript and explanatory feedback.
- Do not reference `/_monica/explain-runtime.js` or any future conversation API in v1.

Make independently discussable concepts future conversation anchors:

```html
<main data-monica-explanation>
  <section id="session-fork" data-monica-explain-anchor>
    <h2>Session fork</h2>
    <!-- one coherent concept -->
  </section>
</main>
```

The element `id` is the future `anchorId`. Use unique, semantic ASCII kebab-case IDs such as `session-fork` or `storage`; never positional IDs such as `section-3`. Keep an anchor stable when wording or layout changes, mark only coherent units that can support a follow-up question, and point table-of-contents links at the same IDs.

**Done when:** the temporary file contains the complete self-contained explanation, interactive quiz, and stable anchors.

### 5. Validate and publish atomically

Inspect the temporary file and fix it until all checks pass:

- it is non-empty and contains a doctype, title, viewport, table of contents, and all explanation functions;
- all table-of-contents targets exist;
- every `data-monica-explain-anchor` has a unique semantic kebab-case `id`;
- all five quiz questions have choices, a correct answer, and distinct explanatory feedback;
- quiz behavior works when browser tooling is available, with source-level JavaScript checks otherwise;
- every code block preserves whitespace;
- no external asset dependency or Monica runtime script is present;
- the layout remains readable at desktop and mobile widths when rendering is available.

Only after validation succeeds, rename the temporary file to `EXPLANATION_DIR/index.html` within the same directory. This same-filesystem rename prevents the server from observing a partially written final artifact. Confirm the final file exists and is non-empty.

**Done when:** the validated document exists at the exact absolute path `EXPLANATION_DIR/index.html` and no partial `index.html` was exposed.

### 6. Report

Return the title and absolute `index.html` path. Keep the response concise so the user can continue asking questions in the same session.

**Done when:** the user can identify the registered explanation and its final artifact.
