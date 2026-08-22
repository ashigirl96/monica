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
