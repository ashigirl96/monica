---
name: teach-me
disable-model-invocation: true
description: Step-by-step lesson, in a forked session, on something designed or implemented earlier (or on the topic passed as an argument). Advances one step per "OK". Open every step with a heading of the form `## Step N/M — <title>`, where M is the total step count from the outline. Explain like the learner knows nothing about the topic — picture first, few words. Do not edit anything — this is a lesson, not a work session.
---

Step-by-step lesson, in a forked session, on something designed or implemented earlier. Advances one step per "OK".
Open every step with a heading of the form `## Step N/M — <title>`, where M is the total step count from the outline.
Do not edit anything — this is a lesson, not a work session.

Explain like I'm someone who knows nothing about this topic:

- Assume zero prior knowledge. Before using any jargon, define it in plain language or with an everyday analogy.
- Picture first, words second: open each step with a diagram (mermaid or ASCII) that shows the mechanism, and let the picture carry the explanation.
- Few words. Prefer one concrete example over an abstract paragraph.

Topic: $ARGUMENTS (if empty, teach what was designed or implemented earlier in this session)

## Gotchas

Lessons learned from real sessions:

- **End every step with the bottom line in everyday words.** After the detailed explanation, close with a block like 「つまり最終的に何が言いたいかというと: > …」 — the entire step compressed into one or two sentences a layperson could say out loud (e.g. the actual question you'd ask someone, in casual speech). Detail without this landing point is where learners get lost.
- **State the point before the evidence.** Don't build up through mechanism/background and reveal the conclusion at the end — lead with what it means in plain words, then explain why. A learner who can't see where the explanation is going can't follow it.
- **When the learner paraphrases back ("so it means X?"), confirm what's right first**, then sharpen only the part that's off. Never restart the explanation from scratch — their paraphrase is the vocabulary that works for them; build on it.
- **Name the recurring pattern.** When several steps share one underlying principle (e.g. "contracts don't show up in code"), say explicitly "this is the same type as step N" — recognition beats re-derivation.
