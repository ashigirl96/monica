---
name: Monica Task
about: Monica が実行可能な作業単位として扱う Issue
title: ""
labels: []
assignees: []
---

## Context

<!-- なぜこの作業が必要か。関連する背景、現在の問題、前提を書く。 -->

## Goal

<!-- 完了したら何が true になっているべきか。 -->

## Out of Scope

<!-- 今回やらないこと。Claude Code が勝手に scope を広げないために必須。 -->

## Acceptance Criteria

- [ ]
- [ ]
- [ ]

## Verification

<!-- 確認方法。test command / manual check / expected behavior。 -->

```bash
# commands to run, if any
```

## Agent Instructions

- 変更はこの Issue の scope に限定する。
- 関連しないコードを refactor しない。
- public な振る舞いを変える場合は承認を求める。
- 終了前に変更ファイルを要約する。

## Links

<!-- 関連 Issue / PR / docs / Slack thread など。 -->

## Monica Metadata

```yaml
kind: task # task | research | proposal
agent: claude-code
requires_approval: true
status: ready # ready | running | need-review | need-intervention | pr-open | done
```
