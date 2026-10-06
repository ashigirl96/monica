## 構成

repo の形と規則は `docs/packages.md` から読む。全文を読み、冒頭の「索引」から作業が触る範囲の文書を開く。

外の道具（Bun・drizzle・oRPC・claude・macOS・git など）の振る舞いに頼るコードを書くときは、`docs/gotchas.md` で落とし穴を確かめる。

## Agent skills

### Issue tracker

issue は GitHub Issues（`ashigirl96/tania`）で管理し、`gh` CLI で操作する。詳細は `docs/agents/issue-tracker.md`。

### Triage labels

5 つの正準な triage ロールはデフォルトのラベル名をそのまま使う。詳細は `docs/agents/triage-labels.md`。

### Domain docs

single-context。リポジトリ直下に `GLOSSARY.md` 1 つと `docs/adr/`。詳細は `docs/agents/domain.md`。

## Code Review Rules

- レビューは指摘もまとめも日本語で書く。
