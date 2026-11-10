# Study

ユーザーは Study（学習）を始め、Tutor（先生）と会話して学ぶ。Tutor の答えは画面に流れながら届き、Tutor は Study の dir に `MISSION.md`・`RESOURCES.md`・`log.md` などを書く。Backend を起こし直しても、同じ Study Conversation（学習の会話）の続きから話せる。Tutor は箱の中で動き、ユーザーの HOME も手元の口も読めない。

## Sub-features

- `start`: Study を始めると、`$H/studies/study-*/` ができ、`list` に出る。
- `converse`: `send` の発言に Tutor が答え、`watch` に turn の始まり・行・文の続き・終わりが流れる。途中で開いた `watch` も続きから受ける。
- `resume`: Backend を起こし直した後の `send` に、前の turn の話を覚えて答える。
- `box`: Tutor の Bash の `HOME` は `<Study の dir>/env/home` で、本物の HOME と手元の口は断られる。
- `study-screen-start`: rail の Study で `/studies` に移り、打って始めると Study の画面に移って Tutor の文が流れる。
- `study-screen-list`: 新しい会話の画面の一覧に Study が区分ごとに出て、名前は Mission の 1 行目になる。行を押すと同じ会話に戻る。
- `study-screen-converse`: turn の途中で読み込み直しても、2 つ目の Browser Tab でも、途中の文から続きが流れる。
- `study-new-key`: Study の画面で ⌥N を押すと `/studies` に戻る。
- `study-shell`: Study の画面の上の欄の `monica study shell <短い id>` を押すと写され、端末で打つと Study の dir に入る。shell の `HOME` はユーザーのままで、`env/env.sh` を読む。
- `study-playground`: Tutor が入れた道具は `env/` の下に入り、`env/env.sh` に PATH の行が書かれる。docker の物には `monica.study=<Study の id>` の label が付く。一覧の行は Playground が消えた Study に「Playground は消えた」を出す。

## How to get to it (user POV)

- web の rail の Study（`/studies`）。新しい会話の画面で打つと Study が始まり、`/studies/<Study の id>` の画面で Tutor と話す。
- 画面を通さずに確かめるときは、ブラウザの口（`MONICA_BROWSER_PORT`）の `study.*` の RPC を呼ぶ。

## Driving it with headless の Backend・Vite・agent-browser

Preconditions: `note-daily.md` の「Driving it with headless の Backend・Vite・agent-browser」と同じ（ブラウザの口と Vite を起こし、agent-browser は `--session verify-<name>`）。claude は本物を使う。

- **study-screen-start.** `open http://localhost:<Vite の port>/` の後、rail の Study を `click` して URL が `/studies` になる。入力欄に「https://github.com/sindresorhus/ky のコードを読んで分かりたい」を打って「始める」を押すと、URL が `/studies/study-*` になり、Tutor の文が流れる（`ThinkingIndicator` の後に文が伸びる）。
- **study-screen-list.** Tutor が `MISSION.md` を書いた後、上の欄の名前が Mission の 1 行目になる。⌥N で `/studies` に戻ると、一覧の「今日」に同じ名前で出る。行を押すと同じ会話に戻る。
- **study-screen-converse.** turn の途中で `open` で読み込み直すと、途中の文から続きが流れる。2 つ目の Browser Tab で同じ URL を開くと同じ文が流れる。Vite の proxy 越しでも流れが途切れない。
- **見た目.** Study の画面に背景写真と右下の pill が無い。theme を dark にすると面と影も dark になる。⌘+ で会話の字が大きくなる。
- **証拠.** 各段の `screenshot` を `$E/study-screen-*.png` に残す。

## Driving it with RPC

Preconditions: `launch.sh <name> MONICA_BROWSER_PORT=<port>` で dev の Backend を起こし、`doctor.sh <name> --wait` が `OK`。claude は本物を使う（dev の Backend は node_modules の claude を起こす）。RPC は、`surfaces/headless.md` の 5 の形で、ブラウザの口に向けた RPCLink（`Sec-Fetch-Site: same-origin`）の script で呼ぶ。script は `packages/study/` の下に置き、`ContractRouterClient<{ study: typeof contract }>` で組み、終わったら消す。

- **start と converse**: `watch` を開いてから `start` → `send`（「https://github.com/sindresorhus/ky のコードを読んで分かりたい」）。`watch` に `snapshot`・`turn-started`・`message`（`user`）・`delta`・`message`（`tutor`・`tool`）・`turn-ended` が流れる。`$H/studies/study-*/MISSION.md` ができ、`list` の `missionLine` がその 1 行目になる。
- **途中で開いた watch**: turn の途中で 2 本目の `watch` を開くと、`snapshot` の `running` が true で、`partialText` の続きから同じ event を受ける。1 本目を閉じても turn は終わりまで走る。
- **Tutor の切り替え**: Backend の stderr に plugin の error が無い。`get` に `tutor_switch` の `repository` の行がある。
- **箱と Bash の HOME**: Tutor に `echo $HOME` を走らせると `<Study の dir>/env/home`。`git clone https://github.com/sindresorhus/ky env/sources/sindresorhus/ky` と `git init prototypes/check` が通る。`env/env.sh` に `export STUDY_ENV_CHECK=1` を書かせた後の `echo $STUDY_ENV_CHECK` が同じ session で出るかを記録する（`packages/study/tutors/TEACHING.md` の「The box」の書き方はこの結果に合わせる）。
- **env**: Tutor に `env | sort` を走らせ、出た key が allowlist と claude が足すものと `.claude-env.sh` の `HOME` だけで、login shell の rc が export した key が無い。
- **断られるもの**: Tutor に `ls <本物の HOME>/.ssh`（箱の中の `~` は `env/home` を指すので絶対 path で書く）と `curl --noproxy '' http://127.0.0.1:<port>/` を走らせ、どちらも断られる。
- **resume**: Backend に SIGTERM を送ると claude とその子が居なくなる（`ps -A -o pid=,ppid=,pgid=,command=`）。起こし直して `send` すると、前の turn の話を覚えて答える。

## Playground と monica study shell

Preconditions: 「Driving it with headless の Backend・Vite・agent-browser」と同じ。CLI は `MONICA_HOME=$H bun apps/cli/src/main.ts study shell …` で dev の Backend に繋ぐ。

- **道具を入れる**: Tutor に「jq を npm で `-g` で入れて使って」と頼む（`npm i -g node-jq` などでよい）。`$H/studies/<id>/env/npm` の下に入り、`env/env.sh` に PATH の行が書かれ、同じ会話の次の Bash でその道具が見える。
- **docker の label**: Tutor に label 付きの container を起こさせ、許可の欄で許す。`docker ps -a --filter label=monica.study=<id>` に出て、`docker compose` の物には `com.docker.compose.project=<id>` が付く。箱の外の docker が、`.claude-env.sh` の `HOME`（`env/home`）のせいで Docker Desktop の context を見失わないかも見る。見失えば `.claude-env.sh` を直す。
- **上の欄の command**: Study の画面の上の欄の `monica study shell <短い id>` を押すと「写した」の toast が出る。Tab に貼って打つ（`features/workbench-tab.md` の手順）と、Study の dir に移り、入れた道具が PATH にあり、`echo $HOME` はユーザーの HOME。`exit` で元の shell に戻り、CLI は exit 0。
- **重なる頭と無い頭**: 近い時刻に Study を 2 つ始めると頭 8 文字が重なる。その頭を打つと stderr の 1 行目が `BAD_REQUEST: <頭> matches 2 Studies: …` で exit 1、無い頭は `NOT_FOUND: …` で exit 1、Backend を止めると `BACKEND_NOT_RUNNING: …` で exit 2。
- **一覧の印**: `sqlite3 $H/monica.db "UPDATE study SET playground_removed_at = <今の ms> WHERE id = '<id>'"` の後に一覧を開き直すと、その行に「Playground は消えた」が出る（Backend は DB を EXCLUSIVE で開くので、止めてから書いて起こし直す）。`monica study shell` で入ると印が消える。
- **証拠**: 各段の `screenshot` と CLI の stderr・exit code を `$E/study-shell-*` に残す。

## release の build で Tutor の定義を書き出す

release の Backend は同梱の `packages/study/tutors` を、起動のたびに `$H/tutors` へ消してから写し、Study の claude にはそちらを渡す。

- 起こす: `bun run install-app --stage <dir>` で置いた `<dir>/Monica.app` の Backend を、`VERIFY_BACKEND=<dir>/Monica.app/Contents/MacOS/monica-backend .claude/skills/verify-monica/scripts/launch.sh <name> MONICA_CLAUDE_PATH=<dir>/Monica.app/Contents/MacOS/claude MONICA_BROWSER_PORT=<port>` で起こす（`surfaces/headless.md` の「起こす」の 1）。
- `diff -r packages/study/tutors $H/tutors` が何も出さない。
- `$H/tutors/stale.md` を置いて起こし直すと消えている。
- `watch` を開いて Study を始めて `send` すると、`turn-ended` の `error` が null で、init の `skills` に `tutors:repository` があり、`get` に `tutor_switch` の `repository` の行がある。
- `bun run` の Backend（`launch.sh <name>`）では `$H/tutors` ができない。

## Agent SDK の版を上げたとき

Study の箱の効き目は、確かめた版のものしか分からない。`@anthropic-ai/claude-agent-sdk` の版を変えたら、新しい版と同梱の claude で次を確かめる。`tutorBox` の options を `query()` に渡す使い捨ての Bun の script を `packages/study/` の下に置き、終わったら消す。

- 置くもの: `mktemp -d "$HOME/.monica-box-check.XXXXXX"` を monica の home にし、その下に Study の dir・Tutor の dir（`skills/repository/SKILL.md` を 1 つ）・`learning-preference/`。`python3 -m http.server --bind 127.0.0.1 <port>` を 1 つ立てる。
- options: `tutorBox` の値に `model: 'claude-haiku-5-5'`・`settingSources: []`・`persistSession: false`・`env: { USER, HOME, PATH, ...tutorBox の env }` を足す。prompt は「次の command を Bash で 1 回だけそのまま走らせる: …」。`canUseTool`・hook・`askUser` に来たものを記録する。
- 見ること:
  - `ls ~/.ssh`・`ls ~/.claude`・`head -c 1 ~/.monica/backend.json >/dev/null` が `Operation not permitted`。
  - Tutor の dir の `SKILL.md` は `cat` で読め、`echo x > <Tutor の dir>/w.txt` は断られる。Study の dir と `learning-preference/` には書ける。
  - `ln -s ~/.ssh <Study の dir>/link` の後の `cat <Study の dir>/link/known_hosts` と、Read の tool での同じ path が断られる。
  - `curl -sS -o /dev/null -w '%{http_code}' https://example.com/` が 200。`curl --noproxy '' http://127.0.0.1:<port>/` と、`0.0.0.0`・`localhost`・`foo.localhost`・`127.0.0.1.nip.io`・LAN の IP を宛先にした同じ command が 403。`canUseTool` の記録に `SandboxNetworkAccess` の host が来ている。
  - `( echo hi )` が走る。
  - 「`docker ps` を箱の外で走らせて」で `askUser` が 1 回呼ばれ、断りの message が tool の結果として Tutor に返る。
  - nix がある Mac で `nix store info` が `Store URL: daemon`。
  - mise がある Mac で `HOME=<Study の dir>/env/home MISE_DATA_DIR=<Study の dir>/env/mise mise install jq@1.7.1 && HOME=<Study の dir>/env/home MISE_DATA_DIR=<Study の dir>/env/mise mise exec jq@1.7.1 -- jq --version` が `jq-1.7.1`。
  - Read で `~/.monica/backend.json`、Write で `<Tutor の dir>/w.txt` が断られ、Write で `<Study の dir>/notes.md` と `learning-preference/LEARNING-PREFERENCE.md` が通る。
  - WebFetch の `http://127.0.0.1:<port>/`・`http://monica.localhost:<port>/`・`http://127.0.0.1.nip.io:<port>/` が hook で断られ、server の log に何も届かない。`https://example.com/` は通る。
  - 箱の中の `echo $TMPDIR` が `/tmp/monica-tutors` の下になる。`/tmp/claude-<uid>` の実 path の `ls` と、そこに置いた canary の `cat` が断られる。`mktemp`・heredoc・`run_in_background` の Bash が動き、Tutor が background の出力を読める。
- 終わったら `$HOME/.monica-box-check.*` と server を消す。

## Gotchas

- 答えは本物の claude が返し、`send` の 1 回ごとに課金される。確かめる発言は少なくする。
- Study の dir は `$H/studies/` にあり、`cleanup.sh` で消える。証拠にする file は `$E` へ写す。
- release の Backend が Tutor の定義を書き出せないと、stderr に `[backend] could not write the Tutors:` が出て、turn は `turn-ended` の `error` で終わる。
