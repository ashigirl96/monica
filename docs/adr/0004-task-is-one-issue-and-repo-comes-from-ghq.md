---
status: accepted
---

# Task は GitHub Issue と 1:1 にし、Project を持たず Repo は ghq のレイアウトから導く

旧 Monica の Task は Issue を 0..1 で持ち、Issue は `external_refs` と title / state のキャッシュに分かれ、reopen の経路が無いので同じ issue に再挑戦するたびに Task が増えた。Project は `owner/repo` と checkout の path と default branch に加えて実行設定まで持ち、Task の `project_id` は NULL 可だった。monica では Task を「1 つの Issue に対する私の作業」と定め、Issue を first-class のローカルの写しにし、Task:Issue を 1:1 で reopen 可にする。GitHub 無しの Task は認めない。Project という実体は持たず、Repo は `owner/repo` で識別し、checkout の場所は ghq のレイアウト（`$(ghq root)/github.com/<owner>/<repo>`）から、default branch は `origin/HEAD` から導く。

## Considered Options

- **GitHub 無しの raw Task を残す**（旧 Monica 踏襲）: wayfinder など旧 Monica の手順書は「先に issue を立てる」運用で、使われていなかった。Task に title / body を持たせる理由がこれだけだったので捨てた。
- **Task と Issue を 1 つに畳む**: 「PR が merge されて issue は閉じたが Task はまだ片付け待ち」「issue は open のまま Task だけ閉じる」の 2 つの状態が表せない。
- **Project テーブルを残す**: 持っていた 4 つ（`owner/repo`、path、default branch、実行設定）のうち前 3 つは導出でき、実行設定は settings に置ける。導出できるものを登録させると、登録漏れの NULL と二重管理が戻る。

## Consequences

- Task は Issue への参照だけを持ち、独自の番号・title・body・project_id を持たない。名指しは `owner/repo#n`（cwd の Repo が分かる場所では `#n`）。
- Issue は Task が無くても存在する（parent や Blocker として写しただけの issue）。Task の親子は Issue の parent 関係から導き、Task 側に `parent_task_id` は無い。
- Issue の写しは title / state / labels / parent / blocked_by と同期時刻まで。body は写さず、agent は `gh issue view` で読む。
- clone していない Repo の issue も track でき、Bench を開く時点で無ければ `ghq get` する。
- worktree は repo の外（`$MONICA_HOME` 配下）に置く。正確な置き場所と per-repo の agent 設定は settings で決める。
- ghq 以外の場所にある checkout は v1 では扱わない。fork を clone している repo は、issue の repo と ghq の path が食い違うので同じく v1 の外。
- Pull Request は Task に多対多で紐づき、対応は保存した事実ではなく sync 時の導出にする。経路は Bench の branch（`issue-<n>`）と PR の head branch の一致、GitHub 上の closing reference（手動リンクを含む）の 2 つで、和集合を経路つきで記録する。手動で繋ぐ command は持たない。close の UnpublishedCommits guard を免除する根拠は branch 一致の merged PR だけで、closing reference だけの merged PR は別 branch の仕事とみなす。免除するのはその PR の head から辿れる commit だけで、merge の後や reopen の後に同じ branch へ積んだ commit は守る。
- Blocker の gate は Issue の写しの open / closed だけで判定する。旧 Monica の「open でも merged PR があれば解けた扱い」（default branch 以外へ merge された stack の救済）は持ち込まず、`--force` で越える。
