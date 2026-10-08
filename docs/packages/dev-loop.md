# dev loop、release、検査、版

## dev loop

- `bun run desktop` が `scripts/desktop.ts` を走らせる。
  1. `MONICA_HOME` が無ければ `~/.monica-dev` を設定し、`MONICA_BIN=<repo>/scripts/monica-dev` を設定する。home を `mkdir -p` し、`scripts/dev-instance.ts` の `devInstance` で home から identifier と vite の port の第一候補を引く（ADR-0007）。
     - `MONICA_HOME` が release の `~/.monica`（realpath で比べる）なら、何もせずに exit 1 する。release の Tab は `MONICA_HOME=~/.monica` を継ぐので、そこで打つと dev の Shell が release の `bin/monica` を worktree に張り替え、release の DB で Backend を起こす。`dev:list` は release の home を出さないので、`dev:kill` でも止められない。
     - 既定の home は `com.ashigirl96.monica.dev` と 1420 のまま。ほかの home は `com.ashigirl96.monica.dev.<home の basename>-<hash>` と、1421 からの範囲に hash で散らした port で、1420 は使わない。
     - `devInstance` は notes の口の port と `apps/web` の Vite の port も返す。既定の home は 19381 と 19581、ほかの home は同じ hash で 19382〜19481 と 19582〜19681 に散らす（release の notes の口は 19380）。notes の口の port は env `MONICA_NOTES_PORT` に入れ、Shell は Backend の env を消さずに起こすので Backend まで届く。vite の port と違って空きを探さない。`apps/web` の Vite も同じ home から port を引いて proxy するので、ずらすと届かなくなるため。埋まっていれば Backend は notes の口なしで起きる（`docs/packages.md` の「notes の口」）。
     - hash は home の realpath から取る。basename だけだと `~/.monica-s2` と `$TMPDIR/monica-s2` が同じ identifier になり、後から起こした方が先の窓に回される。realpath にそろえないと、`$TMPDIR` の下の同じ home が `/var/…` と `/private/var/…` の 2 通りに書けて別の identifier になり、single-instance をすり抜ける。
  2. `cargo build -p monica-ptyd` を行う。externalBin は release の build だけが渡す（「release build と install」の節）ので、`binaries/` には何も置かない。
  3. 第一候補から上へ、127.0.0.1 と ::1 の両方で bind できる最初の port を選ぶ。vite は `localhost` で listen し、どちらの loopback に bind するかは名前解決の順で決まるため。選んだ port は env `MONICA_DEV_URL`（`http://localhost:<port>`）に入れる。Shell は Backend の env を消さずに起こすので、Backend の CORS まで届く。
     - 空きを確かめてから vite が bind するまでの間は port を押さえない。vite は自分で socket を開くので、確かめた socket を渡せないため。ほぼ同時に起こした 2 つの home が同じ port を選ぶと、後の vite は `strictPort` で落ちる。起こし直せば次の空きを選ぶ。
  4. `tauri dev --config src-tauri/tauri.dev.conf.json --config '<JSON>'` を起動する。dev の config は productName と identifier（既定の home の値）を release から分ける。後ろの JSON は home ごとの `identifier` と `build.devUrl` で上書きし、`build.beforeDevCommand`（`bun run dev --port <port>`。vite の `strictPort` は残す）で vite を起こす。
     - identifier か `devUrl` が前回と違うと `TAURI_CONFIG` が変わり、desktop の crate を build し直す。agent は worktree ごとに決まった名前の home を使う（`desktop-dev` skill）ので、build し直すのは worktree ごとに最初の 1 回だけ。
     - mcp-bridge の port は plugin が 9223 から空きを選び、log の `MCP Bridge plugin initialized … on 127.0.0.1:<port>` に出す。
- debug build の Shell は Backend として `bun --watch apps/backend/src/main.ts` を起動し、ptyd の場所 `target/debug/monica-ptyd`（`MONICA_PTYD_PATH` で差し替え可）を env `MONICA_PTYD_PATH` で Backend に渡す。ptyd を spawn するのは Backend で、場所は debug でも release でも Shell が env `MONICA_PTYD_PATH` で渡す（release は Shell の隣の `monica-ptyd`。ADR-0011）。Backend は package や apps/backend の編集と `bun run generate` で同じ pid のまま再起動し、webview は `backend-endpoint` event で再接続する。byte は Shell の ptyd 接続を通るので、この再起動で端末は切れない。
- webview は vite の HMR。package の `ui` も source のまま読む。
- ブラウザに配る notes の画面は、`bun run web`（`apps/web` の Vite）で起こす。`bun run desktop` は起こさない。Workbench だけを見る dev と agent に Vite を 1 つ余計に持たせないため。
  - `MONICA_HOME` が無ければ `~/.monica-dev`。`devInstance` の Vite の port で `strictPort` で listen し、`/rpc` と `/api/assets` を同じ home の Backend の notes の口（`http://127.0.0.1:<notes の port>`）へ proxy する。Host を書き換える（`changeOrigin`）ので、notes の口の Host の照合を通る。`Sec-Fetch-Site` はブラウザが Vite に付けた `same-origin` がそのまま届く。
  - その Backend が居なくても、他の口には倒さない。旧 Monica の Vite は dev の Backend が居ないと release の口に倒れ、release の note に書いていた。`MONICA_HOME` が release の home なら、`scripts/desktop.ts` と同じく起こさずに落ちる。
  - Backend に届かない request には 502 を返さず、接続を切る。release の口では接続が拒まれるので、画面がどちらでも同じ network error を見て再接続の帯を出すため（`docs/packages/note-ui.md` の「再接続の表示と beforeunload」）。
  - dev の Backend の notes の口は SPA を配らない（`bun run` の Backend には `--asset` の `dist` が無い）。開くのは Vite の URL（既定の home は `http://localhost:19581`）。
- `bun run monica <args>` は `scripts/monica-dev`（`bun apps/cli/src/main.ts "$@"`）を呼ぶ。`MONICA_HOME` が無ければ `~/.monica-dev`。
- `bun run dev:list` は、動いている dev と残った home を `MONICA_HOME` ごとに並べる（desktop か headless か、desktop・Backend・ptyd の pid、mcp-bridge の port、worktree）。Backend の env は `ps` で読めないので、home は ptyd の `--monica-home` と `~/.monica-*`・`$TMPDIR/monica-*` から集め、Backend は `backend.json` の pid から、desktop はその親から引く。bridge の port は desktop の pid が LISTEN している TCP の port（`lsof`）。release の `~/.monica` は出さない。
- `bun run dev:kill <NAME>` は desktop → Backend → ptyd の順に止める。逆にすると、Shell が Backend を、Backend が ptyd を起こし直す。`$TMPDIR` の下の home は消し、`~/.monica-dev` は Workbench Ledger の layout があるので残す。
- Shell は起動時に `$MONICA_HOME/bin/monica` → `MONICA_BIN` の symlink を張る。release の desktop だけが `~/.local/bin/monica` にも張る（ADR-0006）。dev の desktop が張ると release の CLI を上書きするため。Workbench の tab の PATH に `$MONICA_HOME/bin` を前置するのは shim（`docs/packages/tab-env-and-shim.md`）。
- `MONICA_HOME` は direnv に書かない（ADR-0006）。
- `.claude/skills` は生成しない。Skill は plugin として repo から in-place で読まれる（ADR-0006）。
- Skill を使うには、user scope の `~/.claude/settings.json` に monica の checkout を directory marketplace として登録し、`monica@monica` を enable する。登録はユーザーが行う。project scope には書かない。Skill はどの repo で動く agent にも配るため。

  ```json
  {
    "extraKnownMarketplaces": {
      "monica": { "source": { "source": "directory", "path": "<ghq root>/github.com/ashigirl96/monica" } }
    },
    "enabledPlugins": { "monica@monica": true }
  }
  ```

  - `path` は worktree ではなく main の checkout を指す。worktree は消すと plugin ごと読めなくなる。
  - checkout はその場で読まれ、SKILL.md の編集は `/reload-plugins` で効く。呼び名は `/monica:<name>`。
  - manifest は `claude plugin validate .` で確かめる。`version` が無いという warning は意図どおり（ADR-0006）。
- cargo の初回 build は約 36 秒（#8）。

## release build と install

- `bun run build` が `scripts/build.ts` を走らせる。
  1. `cargo build --release -p monica-ptyd`
  2. Backend: `apps/web` を `vite build` してから、`bun build --compile --minify-whitespace --minify-syntax --bytecode --format=esm --asset packages/<d>/migrations/<d> … --asset apps/web/dist apps/backend/src/main.ts`。`--asset` には `meta/_journal.json` のある migrations folder をすべて渡す。build.ts が glob で集めるので、domain の package を足しても build.ts は直さない。並べ忘れても検査は通り、release の Backend だけが migrate で落ちるため。`--asset` は folder を basename の位置（`/$bunfs/root/<basename>`）に置き、Backend は SPA を `dist` で引く。
  3. CLI: `bun build --compile --minify-whitespace --minify-syntax --bytecode --format=esm apps/cli/src/main.ts`
  4. 3 つの binary を `apps/desktop/src-tauri/binaries/<name>-<rust triple>` に置き、`tauri build --bundles app --config '{"bundle":{"externalBin":[…]}}'`
- externalBin を base の `tauri.conf.json` に書かないのは、tauri-build が cargo の build のたびに `binaries/` の存在を求め、`binaries/monica-ptyd-<triple>` で `target/<profile>/monica-ptyd` を上書きするため。base に書くと dev と CI の clippy にも `binaries/` が要り、空の placeholder は cargo が作った ptyd を潰す。
- `--minify` は使わない。trpc-cli が class 名で instanceof を判定しており、名前が潰れると起動しない。`--bytecode` は top-level await があるので `--format=esm` が要る。
- compiled binary は Bun の runtime だけで約 60MB あり、Backend と CLI で約 120MB になる。
- `bun run install-app` は 起きている Monica を終了させ、`.app` を一時の場所にコピーして codesign と quarantine の解除を済ませてから `/Applications` に置く。署名する前の `.app` を開かせないため。Tab の shell と claude は ptyd が持ち続けるので、終了させても切れない。codesign の identity は Keychain Access で作った自己署名の `Monica`。ad-hoc と違い、build をまたいで署名の同一性が保たれる。
- 署名と notarization（hardenedRuntime 下の Bun の JIT entitlements。Bun の binary は Backend と CLI の 2 つ）は配布を始めるときに決める。

## 検査と CI

- 検査は `bun run check` に集める。何を流すかの正本は `package.json` の `check:ts` と `check:rust` で、CI の job も同じ script を呼ぶ。agent は `bun run check:brief`（引数で `check:ts` なども渡せる）で流す。通れば要約だけ、落ちればテストの Ledger が stderr に書く行を除いた出力を出し、検査の終了コードで抜ける。パイプで出力を絞ると、終了コードがパイプの末尾のものになるため。`check:ts` は最後に apps/desktop と apps/web の `vite build` を流す（`docs/packages.md` の「entry」の bundle の検査）。
- oxlint は型を見る rule も流す。on にしているのは `.oxlintrc.json` の `options.typeAware` で、型は `oxlint-tsgolint` が読む。
- Rust の検査は macOS の runner で流す。Tauri の crate が macOS の system library を要るため。
- Rust の検査は、Rust に関わる file が変わったときだけ走らせる（対象は `ci.yml` の `changes` job の filter）。private repo では macOS の runner の 1 分が 10 分に数えられ、crate は旧 Monica から rename しただけで骨格の後はほとんど変わらないため。GitHub Actions には job 単位の paths filter が無いので、判定は ubuntu の小さな job で行う。
- テストが誤りを捕まえるかを code に変異を入れて確かめるときは、変異の前に `cp` で控えを取り、控えから戻す。`git checkout -- <file>` は HEAD の内容に戻すので、まだコミットしていない変更ごと消える。
- Rust のテストが誤りを捕まえるかを、code に変異を入れて確かめたら、戻したファイルを `touch` してから次のテストを流す。cargo は mtime で作り直しを決めるので、`cp` で取った控えを `mv` で戻すと mtime が古くなり、変異入りの binary のまま走る。
- 整形だけの commit は、SHA を `.git-blame-ignore-revs` に書いて blame から外す。repo は squash merge なので、SHA は merge の後の main のものを後続の PR で足す。GitHub の blame はこのファイルを自動で読み、手元の git は `git config blame.ignoreRevsFile .git-blame-ignore-revs` を 1 回打つと読む。
- tauri の bundle build、knip、jscpd、lefthook は入れない。

## 版

- Bun は `package.json` の `packageManager` で固定し、CI も同じ版を使う。1.4 未満には `--asset` が無い。
- Rust は `rust-toolchain.toml` で `Cargo.toml` の `rust-version` と同じ版に固定し、CI も同じ file から入れる。stable を追うと、clippy に足された lint で、crate に触れた PR が変更と関係なく落ちるため。
- 依存の版は root の `workspaces.catalog` に集め、member は `catalog:` で参照する。`@orpc/*` は trpc-cli が対応する major に固定する（ADR-0003）。
- tsconfig は root の 1 つで、`types: ["bun"]` と DOM の lib を同居させる。browser 側の安全性は `vite build` に任せる。
- tsconfig に `exactOptionalPropertyTypes` と `noPropertyAccessFromIndexSignature` は入れない。前者は zod が推論する `x?: T | undefined` を domain の関数の `x?: T` に渡せず、procedure を足すたびに書き足しが要るため。後者は `env.X` を `env["X"]` と書かせるだけのため。`noUnusedLocals`・`noUnusedParameters` も入れない。oxlint の `no-unused-vars` が同じものを error にしている。
- scripts は root の `package.json` に並べ、1 行に収まらないものは `scripts/*.ts` に書く。just は使わない。
