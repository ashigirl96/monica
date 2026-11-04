---
name: verify-monica
description: "monica を本物の Backend・monica-ptyd・dev の desktop・Chrome Extension の side panel で起こし、ユーザーの経路（CLI・RPC・端末・画面）で動かして証拠を残す。受け入れ条件や変更が実機で動くかを確かめるとき、Backend の起動・終了・ptyd との再接続、Tab の claude と Agent Session、Task の Bench（run・close）、Job の予定の実行、zsh の補完、notes の画面を見るとき、desktop の一瞬だけ出る表示や窓の枠（信号機・vibrancy）を撮るとき、side panel の中身や Chrome Extension の HMR と reload を見るとき、Chrome Extension の ID と鍵を作り直すときに使う。"
---

起動・健康診断・片付けは `scripts/` の 3 つで行う。機能ごとの操作と、何が見えれば動いたと言えるかは `features/README.md` から引く。面ごとの細かい操作は `surfaces/` の文書にあり、地図の各 file がその節を名指す。文書の参照（`surfaces/…`・`features/…`）は、この skill の directory（`.claude/skills/verify-monica/`）から書く。command は repo の root で流す形で書く。地図が名前だけで書く `launch.sh`・`doctor.sh`・`cleanup.sh` は、`.claude/skills/verify-monica/scripts/` のものを指す。

- `surfaces/headless.md`: desktop 無しの Backend・ptyd・CLI・RPC・Tab への打ち込み・Task の Bench・Job・zsh の補完・notes の画面
- `surfaces/desktop.md`: dev の desktop の窓（tauri-mcp、窓の枠、一瞬だけ出る表示、Dock の数、clipboard）
- `surfaces/extension.md`: Chrome Extension の side panel、github.com の頁の Run ボタン、Chrome Extension の ID と鍵の作り直し
- `release-notifications` skill: `.app` の中でしか動かないもの（通知・Dock の数・同梱した claude）

既定の面は headless の Backend。desktop の build は数分かかり、画面の要らない確認は CLI と RPC で足りる。窓や side panel に出るものだけを、`surfaces/desktop.md` と `surfaces/extension.md` で確かめる。desktop は `surfaces/desktop.md` の手順で Backend ごと起こすので、下の「起こす」と「片付ける」を使わない。side panel は、Brave を `surfaces/extension.md` の手順で起こし、Backend を下の `launch.sh <worktree の名前>` で同じ home に起こす。

## 起こす

`<name>` は小文字・数字・`-` の短い名前で、作業ごとに変える（issue 番号など）。home は `$TMPDIR/monica-<name>`、log と証拠は `$TMPDIR/verify-monica/<name>/` に置かれる。

1. Bash の `run_in_background` で起こす。Backend が抜けるまで戻らない。

   ```bash
   .claude/skills/verify-monica/scripts/launch.sh <name>
   ```

   - env は `env -i` で空にしてから渡すので、monica の Tab や Claude Code の中から起こしても、外側の `MONICA_HOME` や `CLAUDECODE` は Backend と Job に届かない。足す env は後ろに `VAR=value` で並べる（`GHQ_ROOT=…`、`MONICA_BROWSER_PORT=…`、`MONICA_CLAUDE_PATH=…`）。後ろの値が先の値を上書きするので、`PATH=/usr/bin:/bin:/usr/sbin:/sbin` で launchd の PATH にもできる。
   - release の build の Backend は、`VERIFY_BACKEND=<…>/Monica.app/Contents/MacOS/monica-backend` を前に付けて起こす。ptyd は同じ directory の `monica-ptyd` になる。doctor の `OK` の行は commit の代わりに `binary=…` を出す。
   - 同じ `<name>` の Backend が居れば起こさずに exit 1 する。並行する他の agent の instance を操作しないため、別の名前で起こす。
   - socket の path が 103 byte を超える名前と、`VAR=value` の形でない引数は断る。

2. 使えるまで待つ。前景で流してよい（中で 0.5 秒ごとに見て、60 秒で諦める）。

   ```bash
   .claude/skills/verify-monica/scripts/doctor.sh <name> --wait
   ```

   `OK …` の行が出たら操作してよい。`backend.json` は ptyd が 3 秒で起きなくても書かれるので、それだけでは使えるとは言えない。doctor は ptyd と CLI の接続まで見る。

## 健康診断

何かおかしいと思ったら、まず `doctor.sh <name>`（`--wait` 無し）を流す。読むだけで、exit 0 なら操作してよい。見るのは次の順で、最初に外れたものを `NG …` で出す。

- home と `backend.json` がある
- `backend.json` の pid が Backend。dev なら `apps/backend/src/main.ts` で cwd がこの checkout（別の worktree の source で動く Backend を確かめていない）、release なら `…/monica-backend`
- `/health` の pid が同じ（port を他の process が取っていない）
- この home の `monica-ptyd` が居て、`ptyd.sock` がある
- CLI が token で繋がる

`OK` の行には commit（`+dirty` は未 commit の変更あり）と証拠の dir が出る。証拠に添えて書く。

`NG backend.json が無い` なら `$TMPDIR/verify-monica/<name>/err.log` を読む。`[launch exited]` があれば Backend は抜けている。その上の行が落ちた理由（ptyd の build の失敗も含む）。

## 操作する

CLI は常に `MONICA_HOME` を自分の home にして流す。この session の env の `MONICA_HOME` はユーザーの home を指していることがある。

```bash
MONICA_HOME=${TMPDIR%/}/monica-<name> scripts/monica-dev <command> [--format json]
```

exit code は 0 = 成功、1 = それ以外の失敗、2 = Backend 不在。CLI に出ていない procedure（`workbench.runspace.create`・`note.daily.open` など）、Tab への打ち込みと画面の読み取り、hook の payload の流し方は、`surfaces/headless.md` の「確かめる」にある。`MONICA_HOME` はそこでも自分の home にする。

機能ごとの手順は `features/` の地図を使う。地図に複数の入口がある機能は、確かめた入口と確かめていない入口を分けて報告する。

## 証拠

証拠は `$TMPDIR/verify-monica/<name>/` に置く。`launch.sh` が `out.jsonl`（Backend の stdout、`endpoint` と `notify` の行）と `err.log` をここに書く。片付けてもこの dir は残るが、同じ `<name>` で起こし直すと `launch.sh` が `out.jsonl` と `err.log` を空にする。前の回の行を証拠にするなら、起こし直す前に `$E` の中で別の名前に写す。

- 本物のユーザーの経路を通す。CLI・RPC・端末への打ち込み・画面の操作で動かし、DB への直接の書き込みや test 用の fake で状態を作らない。DB は Backend が `locking_mode=EXCLUSIVE` で握るので、`sqlite3` で読むのは片付けの前に Backend だけを止めた後。
- 操作と、その後の状態の両方を残す。CLI なら command・stdout・stderr・exit code を `<feature>.transcript` に追記する。画面なら操作の前と後を撮る。
- 見える結果と一緒に副作用を確かめる。Job が書いた file、Tab の shell が作った file、`out.jsonl` の `notify` の行、Bench の branch と worktree（`git worktree list`）。
- 確かめた後の状態は、書いた経路と別の読む経路（`job show`、`agent-session list`、`note.get`）でも読む。
- 証拠の file ごとに、feature の id と入口を添える。

## 片付ける

```bash
.claude/skills/verify-monica/scripts/cleanup.sh <name>
```

- 起こしたときの stdin の sleep を pid file から止め（Backend は EOF で抜ける）、残った ptyd を `dev:kill` で止めて home を消す。名前で process を探して殺さない。
- Task の Bench を確かめたときの `monica-<name>-ghq`・`monica-<name>-origin`・`monica-<name>-mode` も消す。それが別の instance の home（`monica.db` か `backend.json` がある）なら残す。
- Tab の claude が作った `~/.claude/projects` の記録は消さない。取り戻せず、dir の名前は `/` と `-` を見分けないので持ち主も決まらない（`monica-s2/foo` と `monica-s2-foo` が同じ名前になる）。起動の後に名前の当たる dir ができていれば、`消さずに残した` の行で挙げる。
- Backend が 10 秒で抜けなければ、home を消さずに `NG` で止める。
- `OK 片付いた` の行で終わる。`NG` なら `bun run dev:list` で `monica-<name>` の行を見る。
- 失敗した試行の後にも流す。止まらない Backend や port を残さない。
- 起こした Bash の background job は、Backend が抜けると終わる。Backend が落ちたときも、stdin の sleep を止めて終わる。
