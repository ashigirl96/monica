---
status: accepted
---

# Skill は Claude Code plugin で配り、PATH 上の `tania` command を呼ぶことでだけ tania に触る

monica では agent に渡す手順書が `.claude/skills` に 18 個あり、`~/.claude/skills` への手張りの symlink で配っていた。そのうち `monica` CLI を呼ぶ 2 つ（attach-task / track-issue）は `MONICA_HOME=$HOME/monica` を直書きしていたが、原因は `.monica/setup.sh` が direnv で dev home を shell に export していたことで、skill が上書きし返す構図だった。tania では手順書を **Skill**（`tania` を呼ぶ、`packages/<domain>/skills/<name>/SKILL.md`、plugin `tania` で配る）と **開発 skill**（tania repo を開発するための手順、`.claude/skills/`、配らない）に分ける。Skill は PATH 上の `tania` command を呼ぶだけで、env も hook も持たない。home は CLI が `$TANIA_HOME` から解決し、Workbench の tab には app が渡す。hook は Workbench の shim が `--settings` で注入する。

## Considered Options

- **`~/.claude/skills` への symlink**（monica 踏襲）: 手張りで、repo を動かすと切れ、どの package が所有するか見えない。
- **GitHub を marketplace にして install**: 利用者 1 人・マシン 1 台では、ローカル checkout を `directory` source の marketplace として登録すればコピー無しでその場から読まれ、編集が `/reload-plugins` で反映される。GitHub 経由は配布先が増えたときに足す。
- **plugin に hooks を同梱**: Workbench 外の claude session にも発火し、観測する Agent Session が無い。`tania hook claude` は CLI の command であって plugin の hooks ではない。
- **Skill が home を明示**（monica 踏襲）: dev home を direnv に書かなければ不要。monica が `_MONICA_APP_HOME` で direnv に対抗していた仕掛けも要らなくなる。
- **domain ごとに plugin を分ける**: release を分ける理由が無い。skill 名は directory 名だけで決まり package をまたぐ同名は後勝ちになるので、一意性は検査テストで守る。

## Consequences

- repo に置くのは `.claude-plugin/plugin.json`（`skills` に `./packages/task/skills` と `./packages/workbench/skills`）と `.claude-plugin/marketplace.json`（plugin `tania`、source は repo 直下）の 2 つ。`version` は書かない（directory source では不要、GitHub source にしたときは commit に追従する）。
- user scope の `~/.claude/settings.json` に directory marketplace を登録して `tania@tania` を enable する。呼び名は `/tania:<name>`。project scope は使わない。
- `apps/cli` に検査テストを 1 本置く。plugin.json の `skills` から SKILL.md を集め、fenced bash block 中の `tania …` の command path と flag 名が contract から生えた CLI に実在すること、frontmatter の `name` が directory 名と一致すること、directory 名が全 package で一意なこと、`packages/*/skills` が plugin.json に漏れなく載っていること、を検査する。positional の値は見ない。`--help` は backend 無しで動くので test も backend を要らない。
- SKILL.md の規約: `tania …` は fenced bash block に 1 行 1 command で書く。本文中のインラインの `tania …` は command path だけ検査する。
- dev loop では `TANIA_HOME` を direnv / `.envrc` に書かず、`bun run desktop` / `bun run tania` の script が process 内で設定する。dev の Workbench の tab で動く Skill は、app が渡す `TANIA_HOME` で自動的に dev backend を叩く。
- `tania` を PATH に載せるのは desktop の責任。起動時に同梱の CLI を `~/.local/bin/tania` へ symlink し、`TANIA_BIN` で差し替えられるようにする。binary の形（単一か externalBin 分離か）はパッケージ構成で決める。
- monica の symlink（attach-task / track-issue）は Task v1 が動いた時点で外して一括で切り替える。それまでは `tania:` prefix で並存し、description に tania 用と明記して誤発火を避ける。
- どの Skill を持ち込み、どう書き直すかはこの決定の外。Task v1 のスコープと schema が決まってから実装 issue として切る。
