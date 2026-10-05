## 構成

repo の形と規則の正本は `docs/packages.md`。Read 1 回には収まらないので、`^## ` を Grep して、作業に当たる節だけを開く。

- package・entry・import の向き: 「配置」「entry」
- domain をまたぐ呼び出し、Backend の組み立て、テストの seam: 「domain 間の呼び出しと Backend の組み立て」
- procedure と table: 「contract の規約」「migration」
- CLI と desktop: 「CLI（apps/cli）」「desktop（apps/desktop）」
- Workbench と Task の規則: 「Workbench の帳簿」から「Task の帳簿」まで
- dev の起動、release、検査: 「dev loop」「release build と install」「検査と CI」

## Agent skills

### Issue tracker

issue は GitHub Issues（`ashigirl96/tania`）で管理し、`gh` CLI で操作する。詳細は `docs/agents/issue-tracker.md`。

### Triage labels

5 つの正準な triage ロールはデフォルトのラベル名をそのまま使う。詳細は `docs/agents/triage-labels.md`。

### Domain docs

single-context。リポジトリ直下に `GLOSSARY.md` 1 つと `docs/adr/`。詳細は `docs/agents/domain.md`。
