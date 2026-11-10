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
- `study-permission`: Tutor が箱の外で command を走らせたいと、入力欄が許可の欄に替わる。`1` で許し `2` で断ると、会話に 1 行残る。待つ間は一覧に「許可を待っている」が出て、Backend を起こし直すと断ったことになる。
- `study-repo-link`: Study の画面の上の欄の「+ Repo」で Repo を紐付け、印の × で外す。紐付けた Repo は新しい会話の画面の一覧の行にも出る。
- `study-repo-panel`: 紐付けた Repo の画面の左の欄の時系列の下に「Study」の欄が出て、行を押すとその Study の画面に移る。
- `study-artifacts`: 左の成果物の木の項目か、会話の「を書いた」の行を押すと右の欄に中身が出る。成果物の中の相対 link で別の成果物に移る。Tutor が書くと木と開いている欄が読み直される。
- `study-artifact-editor`: 右の欄の「エディタで開く」で、Zed にその file だけが開く。

## How to get to it (user POV)

- web の rail の Study（`/studies`）。新しい会話の画面で打つと Study が始まり、`/studies/<Study の id>` の画面で Tutor と話す。
- 画面を通さずに確かめるときは、ブラウザの口（`MONICA_BROWSER_PORT`）の `study.*` の RPC を呼ぶ。

## Driving it with headless の Backend・Vite・agent-browser

Preconditions: `note-daily.md` の「Driving it with headless の Backend・Vite・agent-browser」と同じ（ブラウザの口と Vite を起こし、agent-browser は `--session verify-<name>`）。claude は本物を使う。

- **study-screen-start.** `open http://localhost:<Vite の port>/` の後、rail の Study を `click` して URL が `/studies` になる。入力欄に「https://github.com/sindresorhus/ky のコードを読んで分かりたい」を打って「始める」を押すと、URL が `/studies/study-*` になり、Tutor の文が流れる（`ThinkingIndicator` の後に文が伸びる）。
- **study-screen-list.** Tutor が `MISSION.md` を書いた後、上の欄の名前が Mission の 1 行目になる。⌥N で `/studies` に戻ると、一覧の「今日」に同じ名前で出る。行を押すと同じ会話に戻る。
- **study-screen-converse.** turn の途中で `open` で読み込み直すと、途中の文から続きが流れる。2 つ目の Browser Tab で同じ URL を開くと同じ文が流れる。Vite の proxy 越しでも流れが途切れない。
- **study-permission.** Tutor に「`docker ps` を箱の外で走らせて」と頼むと、入力欄が「箱の外で走らせてよいか」の欄に替わり、`eval 'document.activeElement.getAttribute("aria-label")'` がその欄の名前を返す。⌥N で一覧に戻ると行に「許可を待っている」が出る。戻って `press 2` で断ると「`docker ps` を断った」の 1 行が残り、Tutor が断られたことを伝えて続ける。もう一度頼み、会話の文を `click` してから `press 1` しても欄は残る。欄を `click` して `press 1` で許すと command が走る。欄が出ている間に `open` で読み込み直しても欄が出る。2 つ目の Browser Tab で答えると 1 つ目の欄も消える。Backend を止めて起こし直すと、欄が消えて「… を断った」になる。
- **study-repo-link.** `note-repo.md` の Preconditions の偽の ghq の root（`acme/alpha` と `acme/gamma`）で起こす。Study の画面の「+ Repo」を押し、窓（placeholder「Repo を選ぶか owner/repo を打つ」）で `acme/alpha` を選ぶと、上の欄に `acme/alpha` の印が出る。もう一度開いて `acme/beta` を打つと、最後に「acme/beta を紐付ける（Repo の一覧に無い）」が出て、選ぶと印が出る。`acme/alpha` の印の ×（aria-label「acme/alpha の紐付けを外す」）で印が消える。⌥N の一覧の行に紐付けた Repo が等幅の字で出る。`/repos` の窓（⌃W）に `acme/beta` が増えていない。
- **study-repo-panel.** `acme/alpha` を紐付けたまま `/repos/acme/alpha` を開くと、左の欄の時系列の下に「Study」の欄と Study の行が出る。行を押すと `/studies/<id>` に移る。`/repos/acme/gamma` には欄が無い。
- **study-artifacts.** 木の項目を押すと右の欄に中身が出て、×（「閉じる」）で閉じると会話が広がる。成果物の中の相対 link（`[用語集](GLOSSARY.md)` など）を押すと、右の欄がその成果物になる。Tutor が学習記録を書くと、木の「学習記録」に「<番号> <題>」が増え、会話の「を書いた」の行を押すとその記録が開く。開いている成果物を Tutor が直すと、欄の中身が変わる。
- **study-artifact-editor.** Study の dir に `.zed/settings.json`（`{"buffer_font_size": 30}`）を置いてから「エディタで開く」を押す。Zed にその file だけが開き、字が大きくならない。ブラウザの口に `POST /rpc/study/artifact/read` で `../../backend.json` を送ると 403 で断られる。
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
