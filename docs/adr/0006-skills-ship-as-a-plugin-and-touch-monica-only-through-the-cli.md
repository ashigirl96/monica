---
status: accepted
---

# Skill は Claude Code plugin で配り、PATH 上の `monica` command を呼ぶことでだけ monica に触る

旧 Monica では agent に渡す手順書が `.claude/skills` に 18 個あり、`~/.claude/skills` への手張りの symlink で配っていた。そのうち旧 Monica の `monica` CLI を呼ぶ 2 つ（attach-task / track-issue）は `MONICA_HOME=$HOME/monica` を直書きしていたが、原因は旧 Monica の `.monica/setup.sh` が direnv で dev home を shell に export していたことで、skill が上書きし返す構図だった。monica では手順書を **Skill**（`monica` を呼ぶ、`packages/<domain>/skills/<name>/SKILL.md`、plugin `monica` で配る）と **開発 skill**（monica repo を開発するための手順、`.claude/skills/`、配らない）に分ける。Skill は PATH 上の `monica` command を呼ぶだけで、env も hook も持たない。home は CLI が `$MONICA_HOME` から解決し、Workbench の tab には app が渡す。hook は Workbench の claude wrapper（`$MONICA_HOME/bin/claude`）が `--settings` で注入する。

## Considered Options

- **`~/.claude/skills` への symlink**（旧 Monica 踏襲）: 手張りで、repo を動かすと切れ、どの package が所有するか見えない。
- **GitHub を marketplace にして install**: 利用者 1 人・マシン 1 台では、ローカル checkout を `directory` source の marketplace として登録すればコピー無しでその場から読まれ、編集が `/reload-plugins` で反映される。GitHub 経由は配布先が増えたときに足す。
- **plugin に hooks を同梱**: Workbench 外の claude session にも発火し、観測する Agent Session が無い。`monica workbench hook claude` は CLI の command であって plugin の hooks ではない。
- **Skill が home を明示**（旧 Monica 踏襲）: dev home を direnv に書かなければ不要。旧 Monica が `_MONICA_APP_HOME` で direnv に対抗していた仕掛けも要らなくなる。
- **domain ごとに plugin を分ける**: release を分ける理由が無い。skill 名は directory 名だけで決まり package をまたぐ同名は後勝ちになるので、一意性は検査テストで守る。

## Consequences

- repo に置くのは `.claude-plugin/plugin.json`（`skills` に `./packages/task/skills` と `./packages/workbench/skills`）と `.claude-plugin/marketplace.json`（plugin `monica`、source は repo 直下）の 2 つ。`version` は書かない（directory source では不要、GitHub source にしたときは commit に追従する）。
- user scope の `~/.claude/settings.json` に directory marketplace を登録して `monica@monica` を enable する。呼び名は `/monica:<name>`。project scope は使わない。
- `apps/cli` に検査テストを 1 本置く。plugin.json の `skills` から SKILL.md を集め、fenced bash block 中の `monica …` の command path と flag 名が contract から生えた CLI に実在すること、frontmatter の `name` が directory 名と一致すること、directory 名が全 package で一意なこと、`packages/*/skills` が plugin.json に漏れなく載っていること、を検査する。positional の値は見ない。`--help` は backend 無しで動くので test も backend を要らない。
- SKILL.md の規約: `monica …` は fenced bash block に 1 行 1 command で書く。本文中のインラインの `monica …` は command path だけ検査する。
- dev loop では `MONICA_HOME` を direnv / `.envrc` に書かず、`bun run desktop` / `bun run monica` の script が process 内で設定する。dev の Workbench の tab で動く Skill は、app が渡す `MONICA_HOME` で自動的に dev backend を叩く。
- `monica` を PATH に載せるのは desktop の責任。起動時に `$MONICA_HOME/bin/monica` を CLI へ symlink する。CLI の実体は `MONICA_BIN` で差し替えられ、dev では repo の source を呼ぶ wrapper になる。`~/.local/bin/monica` にも張るのは release の desktop だけにする。dev の desktop が張ると、release の CLI を dev のもので上書きしてしまうため。CLI は Backend と別の compiled binary（ADR-0003）。Workbench の tab の PATH に `$MONICA_HOME/bin` を前置するのは、tab の env を注入する側の仕事。
- 旧 Monica の symlink（attach-task / track-issue）は Task v1 が動いた時点で外して一括で切り替える。それまでは `monica:` prefix で並存し、description に旧 Monica の skill とは別物と明記して誤発火を避ける。
- どの Skill を持ち込み、どう書き直すかはこの決定の外。Task v1 のスコープと schema が決まってから実装 issue として切る。
