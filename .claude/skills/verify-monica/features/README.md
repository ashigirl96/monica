# monica の確かめ方の地図

monica のユーザーから見える振る舞いを確かめるときの正本。操作の前にこの index を読み、合う機能の file を手順として使う。

## 前提

- 自分が起こした instance だけを操作する。ユーザーの release の `~/.monica` と、`bun run dev:list` の他の行は操作しない。
  - headless の機能: `launch.sh <name>` で起こし、`doctor.sh <name>` が `OK` を返したもの。
  - desktop の機能（[Tab の dot と未読](./desktop-agent-dot.md)）: `surfaces/desktop.md` の「起こす」で起こし、tauri-mcp の identifier を確かめたもの。Backend は desktop が起こすので、`launch.sh` と `cleanup.sh` は使わない。
  - side panel の機能（[side panel の Chat](./extension-chat.md)）: `surfaces/extension.md` の「起こす」で Brave を起こし、同じ home に `launch.sh <worktree の名前>` で Backend を起こしたもの。
- `H=${TMPDIR%/}/monica-<name>`、`E=${TMPDIR%/}/verify-monica/<name>` と書く。地図の `monica <command>` は `MONICA_HOME=$H scripts/monica-dev <command>` と読み替えて流す。素の `monica` はユーザーの home の Backend に繋ぐ。`launch.sh`・`doctor.sh`・`cleanup.sh` は `.claude/skills/verify-monica/scripts/` のもの。
- 新しい home には Runspace もユーザーの Job も Note も無い。system の Job（`task.sync` など）だけは起動時からある。各機能の手順は、その機能の前提を自分で作るところから始める。
- home の中（`$H/logs/` など）にあるものは片付けで消える。証拠にするなら `$E` へ写す。

## 操作の決まり

- 各手順は、起こしたばかりの instance から始める。前提が違う手順はその file の `Preconditions:` に書く。
- command は書いたとおりに流す。名前・flag・引用を変えない。
- 画面の操作は、ARIA の名前・`data-*` の属性・route を手掛かりにし、座標と DOM の位置に頼らない。
- 確かめた後に作ったもの（Job、Runspace、Note）は消してよいが、証拠は消さない。

## 証拠と飛ばした入口の報告

- 操作とその後の状態を残す。最後の画面や最後の出力だけでは足りない。
- CLI の証拠は command・stdout・stderr・exit code。`$E/<feature>.transcript` に追記する。
- 書き込みの証拠には、書いた経路と別の読む経路で読んだ値を添える。
- 証拠ごとに feature の id と使った入口を書く。
- 届かなかった入口は、試した command と満たせなかった前提を報告する。別の入口で確かめたものを、その入口の確認として報告しない。

## 各機能の file の形

H1 の title と、ユーザーに見える振る舞いの 1 段落で始め、次の 4 つの H2 をこの順に置く。

1. `Sub-features`: 短い id と 1 行の説明。
2. `How to get to it (user POV)`: ユーザーの入口をすべて。
3. `Driving it with <harness>`: `Preconditions:` で始め、ユーザーの操作・正確な command・見える結果を組にした太字の見出し付きの bullet。
4. `Gotchas`: 確かめる手間を無駄にしたり、結果を無効にしたりする罠。

実装の中身は書かない。ユーザーの経路・手掛かり・要る状態・command・見える証拠だけを書く。

## 機能

- [Job](./job.md): Job の登録・今すぐ走らせる・予定の時刻に走る・結果を見る・止める・消す。
- [Tab と端末](./workbench-tab.md): Runspace と Tab を開き、端末に打ち込み、画面を読み、閉じる。
- [Agent Session の状態](./agent-session.md): Tab の claude の状態（待ち・理由）と通知。
- [Task の Bench](./task-bench.md): Task を run して Bench を作り、close で片付ける。
- [Daily](./note-daily.md): notes の画面で Daily を開いて書き、残ったことを読み直す。
- [Ambient](./note-ambient.md): notes の画面の背景を選び、⌥; で巡り、読み直しても残る。
- [Tab の dot と未読](./desktop-agent-dot.md): desktop の Tab の dot、未読、Dock の数（`surfaces/desktop.md`）。
- [side panel の Chat](./extension-chat.md): Brave の side panel で質問し、答えを受ける（`surfaces/extension.md`）。
