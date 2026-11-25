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

- CLI の `monica task run <ref> [prompt] [--in-place] [--fork <id>]`・`task list`・`task show <ref>`・`task close <ref>`・`task reopen <ref>`。
- desktop の sidebar の Task のラベルと Bench の Tab。

## Driving it with headless の Backend と一時の ghq

Preconditions:

- `gh auth status` が通る（`ghq get` と Issue の読み取りに GitHub が要る）。
- 開いている Issue の ref（`<owner>/<repo>#<n>`）が 1 つある。
- `launch.sh <name> GHQ_ROOT=${TMPDIR%/}/monica-<name>-ghq` で起こした。`GHQ_ROOT` を渡さないと、ユーザーの本物の checkout に worktree を作る。
- 起動の後に `surfaces/headless.md` の「起こす」の 3 の symlink（`$H/bin/monica`）を張った。無いと Tab の claude の hook が `No such file or directory` で落ち、Agent Session と Run が記録されない。
- run には毎回短い prompt を渡す。下では `P='Reply with the single word ok. Do not run any tool.'` と書く。

- **checkout を作る.** `monica task run <ref> "$P" --in-place` を流す。exit 0 で `opened the Bench of <ref> at <checkout>` が出て、`monica-<name>-ghq` の下に clone ができ、`task list` に出る。Tab の claude は trust の確認で止まる（`surfaces/headless.md` の「Tab で本物の claude を起こすとき」）。
- **一時の origin に向ける.** `surfaces/headless.md` の「Task の Bench を確かめる」の 3 の script で、`.monica/setup.sh` を持つ main を一時の origin に push し、checkout の `origin` を向け直す。`monica-<name>` の部分を自分の名前に置き換える。
- **準備の失敗を見る.** mode file に `fail` を書いてから、別の Issue で `monica task run <ref> "$P"` を流す。exit 1 で `PRECONDITION_FAILED: could not prepare the Bench of <ref>: exit 1; see $H/logs/setup/<owner>/<repo>/issue-<n>.log` が出る。その log の末尾は `monica: exit 1`、`task list` の STATE は `setup_failed`。claude は起きない。log は `$E` へ写す。
- **Bench を作る.** mode file を `ok` に戻し、同じ command を流す。`the Bench of <ref> is at $H/worktrees/<owner>/<repo>/issue-<n>` と `started claude in a new Tab` が出る。`git -C <checkout> worktree list` に新しい worktree と branch `issue-<n>` が出る。Tab の画面を読み、trust の確認が出ていれば通す。`task show <ref>` に Run が出る。
- **会話を fork する.** 1 往復した claude の Agent Session の id（`agent-session list` の `sessionId`、Tab の中なら `$CLAUDE_CODE_SESSION_ID`）を、別の Task に渡す。`monica task run <別の ref> "<元の会話を問う短い prompt>" --fork <id>`。出力に `forked claude <id> into a new Tab` が出て、新しい Tab の claude が元の会話を覚えており、`task show <別の ref>` に元と違う Agent Session の新しい Run が出る。
- **片付ける.** Bench の Tab の claude に `/exit` を打ってから、`monica task close <ref>` を流す。`closed <ref>`・`removed the worktree …`・`deleted the branch issue-<n>` が出て、worktree と branch が消え、`task list --closed` に移る。
- **開き直す.** `monica task reopen <ref>` で `reopened <ref> …` が出て、`task list` に STATE `not_started` で戻る。
- **証拠.** 各段の command と出力、`worktree list` と `git branch` を `$E/task-bench.transcript` に残す。

## Gotchas

- `--in-place` は ref の後ろに置く。`task run --in-place <ref>` は ref を真偽値として読み、`BAD_REQUEST: option '--in-place [boolean]' argument '<ref>' is invalid` と exit 1 で断る。
- prompt を省くと、Tab の claude に本物の `/tackle` が送られる。claude は権限の確認なしで動き、`--in-place` の時点の checkout の origin は本物の GitHub なので、branch や PR を外に出しうる。
- 同じ Task の生きている Run を `--fork` すると `CONFLICT: <ref> has a live Run …` で断られる。fork 元は別の Task か Bench の外の claude にする。
- 生きている claude（待ちを含む）が Bench にあると、close は `CLOSE_REFUSED: … is a live Run` で断る。`/exit` で終えるか `--force` を付ける。
- setup の失敗は `task show` と `err.log` には出ない。`task run` の出力と `task list` の STATE で見る。
- `cleanup.sh` は `monica-<name>-ghq`・`-origin`・`-mode` を消す。名前の付け方を変えると消し残る。
- Tab で本物の claude が起きる。Agent Session Transcript が `~/.claude/projects` に残る。取り戻せないので `cleanup.sh` は消さず、起動の後にできた dir を挙げる。
- GitHub に届かない環境では最初の run が落ちる。その時は `task-*` を確かめられなかったと報告し、`--in-place` 以外の入口を別の手で代えない。
