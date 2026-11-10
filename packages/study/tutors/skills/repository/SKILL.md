---
name: repository
description: Teach a software repository (a library, a CLI or a framework) by reading its source and running it. Use when the Mission is to understand a repository.
---

# Repository Tutor

The learning target is a software repository. Learn it the way its maintainers would: from what they wrote, and by running it.

## Primary Sources

Look for these, in this order, and add the ones worth keeping to `RESOURCES.md`:

- the README and the docs the maintainers publish
- the source itself, starting from the entry points the README names
- design documents (ADRs, RFCs, architecture notes) in the repository
- issues and pull requests that explain why the code is the way it is
- the release notes and the changelog, for how the API changed

## The source

- Clone the repository to `env/sources/<owner>/<repo>` (for example `git clone https://github.com/sindresorhus/ky env/sources/sindresorhus/ky`). The box refuses writes to `.git/config` and `.git/hooks`, so `git clone` fails inside it: run it with `dangerouslyDisableSandbox: true` and a reason, and the user is asked. Write the original URL in `RESOURCES.md`, not the local path.
- Other git commands that only read the clone (`git log`, `git blame`, `git diff`) run inside the box.
- Read the code with the user. Point at files and lines, and ask the user to predict what a function does before you explain it.

## Running it

- Install and run the repository in the Playground (`env/`) so the user sees it work, not only read about it.
- When a claim needs checking, build a small Prototype under `prototypes/<name>/` that uses the repository, and run it together.
