# Tab と端末

ユーザーは Runspace を開き、その Tab の端末で shell を使い、Tab を閉じると shell も終わる。

## Sub-features

- `tab-open`: Runspace を 1 つの Tab と新しい Terminal Session で開く。
- `tab-write`: Tab の端末に打ち込んだ command が shell で走る。
- `tab-screen`: 端末の画面に結果が出る。
- `tab-show`: Tab の Terminal Session と process の表を見る。
- `tab-close`: Tab を閉じると Terminal Session が終わり、shell の子も止まる。

## How to get to it (user POV)

- desktop で ⌥P（新しい Runspace）、Ctrl+T の後に `c`（隣に Tab）。
- CLI の `monica workbench tab show`・`tab close`・`runspace show`・`runspace remove`。
- 開くのは CLI に出ていないので、headless では RPC の `workbench.runspace.create`。

## Driving it with headless の Backend と ptyd の socket

Preconditions:

- `doctor.sh <name>` が `OK`。
- 新しい home なので `monica workbench terminal-session list` は空。

- **Runspace を開く.** RPC の `workbench.runspace.create` を `{ cwd: "$E" }` で呼ぶ（呼び方は `surfaces/headless.md` の「確かめる」の RPC）。応答の `tab.id` と `tab.terminalSessionId` を控える。`monica workbench terminal-session list --format json` にその id が出る。
- **打ち込む.** ptyd の socket に `write` を送る（`surfaces/headless.md` の「Tab への打ち込みと画面」）。data は `echo verify-ok > tab-proof.txt; echo done\r` の base64。`$E/tab-proof.txt` に `verify-ok` が書かれる。
- **画面を読む.** 同じ節の `attach` の `replay` を解いて読む。末尾に `done` の行がある。解いた文字を `$E/workbench-tab.screen.txt` に残す。
- **process を見る.** `monica workbench tab show <tab-id>` を流す。shell の行の MARK が `shell` で、STAT が生きている。
- **閉じる.** `monica workbench tab close <tab-id>` を流す。exit 0 で、`terminal-session list` からその id が消え、`tab show` で見た shell の pid が `ps -p <pid>` で居なくなる。

## Gotchas

- ptyd の socket の操作は `bun -e` の script で行う。worktree の session では guard が `bun -e` を断るので、script を scratchpad の file に書いて `bun <file>` で流す。
- `replay` は escape sequence を含む。除いてから読まないと、`done` が色の sequence に割られて見つからない。
- `write` の直後に `attach` すると、shell がまだ出力していない。数秒待ってから読む。
- Runspace の最後の Tab を閉じると Runspace も消える（`runspaceEmptied`）。Runspace が残る前提で次の手順を書かない。
