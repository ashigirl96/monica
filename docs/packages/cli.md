# CLI（apps/cli）

- CLI は Backend と別の compiled binary（ADR-0003）。
- `src/main.ts` は argv を見て、各 package の `cli` entry が export する手書き command（`{ path, description, run }`）に当たればそれを実行する。当たらなければ trpc-cli を dynamic import し、contract の `cli: true` の葉から CLI を組む。hook は tool 1 回ごとに起動するので、trpc-cli と contract の実体を import する前に振り分ける（compiled で約 46ms → 約 18ms）。
- `src/backend.ts` が Backend の探索（`backend.json` の読み出し、不在時の即 exit 2、接続拒否時の 200ms × 3 秒 retry。ADR-0007）と `RPCLink` の生成を 1 箇所で持つ。手書き command には `connect({ retry? }): Client | null` として渡す。hook は `retry: false` で呼び、接続拒否でもすぐ諦める。
- 転送 router（`src/forward.ts`）は contract を走査し、`cli: true` の葉を「remote を呼ぶ → 整形して出力する → `undefined` を返す」handler に置き換える。`undefined` を返すので、trpc-cli の YAML / 表の logger は何も出さない。
- input に `terminalSessionId` を持つ procedure（`current`、`attach`、`close`）には、転送 router が env の `MONICA_TERMINAL_SESSION_ID` を埋める。flag には出さない。
- `--format text|json` は、`createProgram` が trpc-cli の `buildProgram` が返した program に global option として足す（既定は text）。json は procedure の output をそのまま出す。text は `@monica/<d>/cli` の整形関数を procedure の path で引く。整形の識別子は英語（#17）。
- エラーは stderr に出し、1 行目を `CODE: message` にする。Skill は stderr の 1 行目で失敗を読むため。usage エラーと入力の検証エラーも `BAD_REQUEST: <理由>` の 1 行にし、help を続けない。trpc-cli は `ORPCError` を cause に剥がして表示し、remote 由来の `ORPCError` は cause を持たないので、転送 handler が `` new Error(`${code}: ${message}`, { cause }) `` に包んで投げ直す（#8 の詰まった点 1）。stack を出さないよう trpc-cli の `formatError` で message だけにする。`--format json` のときも stdout には成功時の output だけを出す。
- exit code は 0 = 成功、1 = それ以外の失敗、2 = Backend 不在。trpc-cli は usage エラーも handler の throw も 1 で `process.exit` を自分で呼ぶので、`run({ process: { exit } })` で差し替え、投げ返される `FailedToExitError` を catch して写像する。
- `prompts: false` を固定する。
- 補完は zsh にだけ出す。`monica completions zsh` が出す script は固定で、TAB のたびに打った `monica`（`${words[1]}`）の隠し command `__complete -- <語…>` を呼び、返った `値:説明` の行を `_describe` に渡す。候補は `createProgram` が組む commander の木から引くので、command を足しても script を置き直さなくてよい。Workbench の Tab では dev の CLI が、外では release の CLI が答える。trpc-cli の補完（omelette）は使わない。候補に説明が付かず、root の option と引数の値を補完せず、`process.argv` と `process.exit` に直に触るので in-process のテストに載らないため。
  - 引数の値は、各 package の cli entry の `completers`（procedure の path と input の field 名で引く関数）が Backend に聞いて返す。task は ref の位置に、開いている Task（`reopen` では閉じた Task）の ref と題を出す。job は `show` と `run` の名前の位置に Job の名前と schedule を、`remove`・`pause`・`resume` の名前の位置にユーザーの Job の名前と cron 式を出す。Backend には retry せず 1 秒で打ち切り、不在でも失敗でも候補を出さないだけにする。`completers` の key が CLI の command の引数を指すことは、`completion.test.ts` が commander の木で確かめる。
  - commander は `[value]` の option（trpc-cli の boolean）の後ろの語も、`-` で始まらなければ値として食う。`close --force acme/app#1` は ref を失うので、その位置には ref を出さない。
  - 置き方は、fpath にある directory への `monica completions zsh > ~/.zsh/completions/_monica` か、`.zshrc` の `eval "$(monica completions zsh)"`。script は版に依らないので、install-app は dotfiles に書かない。
  - zsh の script は CI で走らせず、手元で zpty から TAB を押して確かめる。起こす zsh の `ZDOTDIR` の `.zshrc` に、`bindkey -e`（`EDITOR` が vi 系だと vi の keymap で起きる）と `stty rows 50 cols 200`（pty の大きさが 0 のままだと候補の一覧を出さない）を置く。
- hook の受け口は `monica workbench hook claude`（`@monica/workbench/cli` の手書き command）。仕様は `docs/packages/tab-env-and-shim.md`。
- Native Messaging の host（`src/native-host.ts`、ADR-0034）: 第 1 引数が `chrome-extension://` で始まると、手書き command と trpc-cli より前に振り分けて host として振る舞う。Chromium は host を manifest の `path` で起こし、第 1 引数に呼んだ Chrome Extension の origin を渡す。manifest の `path` は引数を持てないので、flag ではなく origin で見分ける。
  - stdin から 1 通（4 byte の little-endian の長さと UTF-8 の JSON）を読み、中身は見ずに、home（`MONICA_HOME`、無ければ `~/.monica`）の `backend.json` を `src/backend.ts` の `liveEndpoint` で読んで、`{ port, token: <extensionToken> }` を同じ枠で 1 通書いて exit 0 する。全権の token は返さない。`backend.json` が無い、pid が死んでいる、`extensionToken` が無い（この版より前の Backend）ときは `{ error: 'not-running' }` を返す。
  - `sendNativeMessage` は応答を受けてから stdin を閉じるので、EOF を待たずに 1 通だけ読む。Chromium は応答の後、host が 2 秒で抜けなければ SIGKILL する。
  - どの origin でも同じ答えを返す。起こせる Chrome Extension は manifest の `allowed_origins` で browser が絞る。
  - release の manifest は Shell が、dev の manifest は `bun run extension` が書く（`docs/packages/dev-loop.md`）。
- SKILL.md と CLI を突き合わせる検査テストは apps/cli に置く（ADR-0006。`skill-check.test.ts`）。`createProgram` が組む commander の木を辿って command path と flag 名を引くので、procedure を呼ばず、Backend も要らない。
  - 検査する command は、`bash` か `sh` の fence の中で `monica` から始まる行と、本文のインラインの `monica …`。長い fence の中の fence は例なので見ない。行の `#` から後ろは shell と同じく comment として外す。
  - 親の option（`--format`）と `--help` は、commander と同じく子の後ろでも受ける。
  - fence の中で `[value]` の option の直後に `-` で始まらない語を置いた行は落とす。commander がその語を値として食うため（補完の節）。
  - frontmatter の `name` が directory 名と違う Skill と、package をまたいで同じ名前の Skill は落とす。Skill は `/monica:<name>` で呼ぶので、同じ名前の片方が隠れるため。
  - 手書き command（`monica workbench hook claude`）は contract から生えず、Skill も呼ばないので、木に無く、書けば落ちる。
  - plugin.json の `skills` は、Skill を持つ `packages/*/skills` とちょうど一致させる。Skill の無い directory を載せても落ちる。workbench の `skills` は Skill ができたときに足す。
- oRPC 2.0 で `RPCLink` の引数が変わったときに直すのは、`RPCLink` を作る `apps/cli/src/backend.ts`・`apps/desktop/src/backend.ts`・`apps/web/src/main.tsx` と、その option を組む `packages/note/src/ui/client.ts`（#21）。

## テスト

- remote client を `createRouterClient` に差し替えて回す（ADR-0003。fixture は `apps/cli/src/testing.ts`）。その Task Ledger は失敗する GitHub と ghq を持つ（`docs/packages/task-ledger.md` の「テスト」）。Backend 側のエラーの形と接続拒否の retry だけは、router を `Bun.serve` に載せて確かめる。in-process の client は handler の生の Error を投げ、HTTP のように `ORPCError`（`INTERNAL_SERVER_ERROR`）に包まないため。
- Native Messaging の host も、`apps/cli/src/main.ts` を第 1 引数 `chrome-extension://<id>/` の subprocess で起こし、一時の home に書いた `backend.json` から返す port と token を、枠付きの stdin と stdout で確かめる（`src/native-host.test.ts`）。stdin は応答を読むまで閉じず、EOF を待つ実装なら止まる。`HOME` を一時の dir にして、`MONICA_HOME` が無いときに `~/.monica` を読むことも見る。
- hook の CLI（`monica workbench hook claude`）は例外で、`apps/cli/src/main.ts` を subprocess で起こし、router を `Bun.serve` に載せて確かめる。claude から見た約束（stdin の payload、stdout の allow、exit code）と 2 秒の打ち切り、trpc-cli より前の振り分けは、process の外からしか見えないため。
