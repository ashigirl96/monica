# Task の Bench

ユーザーは GitHub の Issue を Task として run し、monica はその Bench（worktree・branch `issue-<n>`・Runspace）を作って claude を起こす。close すると Bench を片付ける。

## Sub-features

- `task-run`: Issue を Task にし、Bench を作り、Tab で claude を起こす。
- `task-run-in-place`: worktree を作らず checkout のまま Bench にする。
- `task-run-fork`: 指定した Agent Session の会話を fork した claude を Bench の新しい Tab で起こす。
- `task-setup`: Bench の準備で `.monica/setup.sh` が走り、成功・失敗が分かる。
- `task-show`: Task と Run を見る。
- `task-close`: worktree・branch・Runspace を消す。
- `task-reopen`: 閉じた Task を開き直す。

## How to get to it (user POV)

- CLI の `monica task run <ref> [prompt] [--fork <id>]`・`task list`・`task show <ref>`・`task close <ref>`・`task reopen <ref>`。
- desktop の sidebar の Task のラベルと Bench の Tab。

## Driving it with headless の Backend と一時の ghq

Preconditions:

- `gh auth status` が通る（`ghq get` と Issue の読み取りに GitHub が要る）。
- 開いている Issue の ref（`<owner>/<repo>#<n>`）が 1 つある。
- `launch.sh <name> GHQ_ROOT=${TMPDIR%/}/monica-<name>-ghq` で起こした。`GHQ_ROOT` を渡さないと、ユーザーの本物の checkout に worktree を作る。

- **checkout を作る.** `monica task run --in-place <ref>` を流す。exit 0 で、`monica-<name>-ghq` の下に clone ができ、`task list` に出る。
- **一時の origin に向ける.** `surfaces/headless.md` の「Task の Bench を確かめる」の 3 の script で、`.monica/setup.sh` を持つ main を一時の origin に push し、checkout の `origin` を向け直す。`monica-<name>` の部分を自分の名前に置き換える。
- **Bench を作る.** 別の Issue で `monica task run <ref>` を流す。`git -C <checkout> worktree list` に新しい worktree と branch `issue-<n>` が出る。`task show <ref>` に Run が出る。
- **会話を fork する.** monica の Tab で起こした claude に 1 往復話してから、その Tab で `monica task run <ref> --fork "$CLAUDE_CODE_SESSION_ID"` を流す。出力に `forked claude <id> into a new Tab` が出て、Bench の新しい Tab の claude が元の会話を覚えており、`task show <ref>` に元と違う Agent Session の新しい Run が出る。
- **準備の失敗を見る.** mode file に `fail` を書いてから run する。`task show` か `err.log` に setup の失敗が出る。
- **片付ける.** `monica task close <ref>` を流す。worktree と branch が消え、`task list` から消える。
- **証拠.** 各段の command と出力、`worktree list` と `git branch` を `$E/task-bench.transcript` に残す。

## Gotchas

- `cleanup.sh` は `monica-<name>-ghq`・`-origin`・`-mode` を消す。名前の付け方を変えると消し残る。
- Tab で本物の claude が起きる。Agent Session Transcript が `~/.claude/projects` に残る。取り戻せないので `cleanup.sh` は消さず、起動の後にできた dir を挙げる。
- GitHub に届かない環境では最初の run が落ちる。その時は `task-*` を確かめられなかったと報告し、`--in-place` 以外の入口を別の手で代えない。
