---
disable-model-invocation: true
description: Create a monica notebook that teaches a topic step by step
---

# guides

Create a notebook (short, focused pages) that teaches the given topic. The agent decides the breakdown.

## Steps

### 1. Scope

Understand what the reader should know by the end. If the topic names a repository or path, explore the code first.

**Done when:** you can state the notebook's learning goal in one sentence.

### 2. Outline

Plan short, focused pages. For each, decide: title, order, and parent (if nested; most guides are flat).

Prefer a problem-to-solution arc — but let the topic dictate the shape.

**Done when:** page list with titles and order.

### 3. Scaffold

Derive a kebab-case slug from the topic. The command prints the absolute path of the created directory — capture it as `NB_DIR`.

```bash
NB_DIR=$(monica notebooks new <slug>)
```

Write all pages under `$NB_DIR/`.

**Done when:** `NB_DIR` is set and the directory exists.

### 4. Write pages

Write each page to the notebook directory. Front matter:

```markdown
---
title: "<title>"
order: <n>
parent: <[[parent-stem.md]] or empty>
created: <ISO 8601>
---
```

Each page should build on the previous ones. Keep each page around 20 lines — split freely into more pages rather than cramming. Use code snippets, Mermaid diagrams, or concrete examples where they clarify.

**Done when:** all outlined pages exist as `.md` files.

### 5. Lint

```bash
monica notebooks lint <slug>
```

Fix fatal errors. Warnings are acceptable.

**Done when:** lint exits 0.

### 6. Q&A

Present the completed outline and ask the user if they have questions. When the user asks about `#N` (an outline number), add a child page under that page:

1. Run `monica notebooks show <slug>` to resolve `#N` to its page file.
2. Write a new `.md` file with `parent: [[resolved-page.md]]` and `order` set to max sibling order + 1.
3. Re-run `monica notebooks lint <slug>`.

Repeat until the user moves on or says they have no more questions.

**Done when:** the user indicates no more questions.
