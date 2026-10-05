# CLI（apps/cli）

- CLI は Backend と別の compiled binary（ADR-0003）。
- `src/main.ts` は argv を見て、各 package の `cli` entry が export する手書き command（`{ path, description, run }`）に当たればそれを実行する。当たらなければ trpc-cli を dynamic import し、contract の `cli: true` の葉から CLI を組む。hook は tool 1 回ごとに起動するので、trpc-cli と contract の実体を import する前に振り分ける（compiled で約 46ms → 約 18ms）。
- `src/backend.ts` が Backend の探索（`backend.json` の読み出し、不在時の即 exit 2、接続拒否時の 200ms × 3 秒 retry。ADR-0007）と `RPCLink` の生成を 1 箇所で持つ。手書き command には `connect({ retry? }): Client | null` として渡す。hook は `retry: false` で呼び、接続拒否でもすぐ諦める。
- 転送 router（`src/forward.ts`）は contract を走査し、`cli: true` の葉を「remote を呼ぶ → 整形して出力する → `undefined` を返す」handler に置き換える。`undefined` を返すので、trpc-cli の YAML / 表の logger は何も出さない。
- input に `terminalSessionId` を持つ procedure（`current`、`attach`、`close`）には、転送 router が env の `TANIA_TERMINAL_SESSION_ID` を埋める。flag には出さない。
- `--format text|json` は `buildProgram` で global option として足す（既定は text）。json は procedure の output をそのまま出す。text は `@tania/<d>/cli` の整形関数を procedure の path で引く。整形の識別子は英語（#17）。
- エラーは常に stderr に 1 行 `CODE: message` を出す。trpc-cli は `ORPCError` を cause に剥がして表示し、remote 由来の `ORPCError` は cause を持たないので、転送 handler が `` new Error(`${code}: ${message}`, { cause }) `` に包んで投げ直す（#8 の詰まった点 1）。stack を出さないよう trpc-cli の `formatError` で message だけにする。`--format json` のときも stdout には成功時の output だけを出す。
- exit code は 0 = 成功、1 = それ以外の失敗、2 = Backend 不在。trpc-cli は usage エラーも handler の throw も 1 で `process.exit` を自分で呼ぶので、`run({ process: { exit } })` で差し替え、投げ返される `FailedToExitError` を catch して写像する。
- `prompts: false` を固定する。
- completions は trpc-cli の生成に任せる（#12）。
- hook の受け口は `tania workbench hook claude`（`@tania/workbench/cli` の手書き command）。仕様は `docs/packages/tab-env-and-shim.md`。
- SKILL.md と CLI を突き合わせる検査テストは apps/cli に置く（ADR-0006。`skill-check.test.ts`）。`createProgram` が組む commander の木を辿って command path と flag 名を引くので、procedure を呼ばず、Backend も要らない。
  - 検査する command は、`bash` か `sh` の fence の中で `tania` から始まる行と、本文のインラインの `tania …`。長い fence の中の fence は例なので見ない。行の `#` から後ろは shell と同じく comment として外す。
  - 親の option（`--format`）と `--help` は、commander と同じく子の後ろでも受ける。
  - 手書き command（`tania workbench hook claude`）は contract から生えず、Skill も呼ばないので、木に無く、書けば落ちる。
  - plugin.json の `skills` は、Skill を持つ `packages/*/skills` とちょうど一致させる。Skill の無い directory を載せても落ちる。workbench の `skills` は Skill ができたときに足す。
- oRPC 2.0 で `RPCLink` の引数が変わったときに直すのは `apps/cli/src/backend.ts` と `apps/desktop/src/backend.ts` の 2 箇所だけ（#21）。
