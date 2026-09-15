# Monica の運用

Monica がどこに立ち、誰と何を分担し、日々どう使われることを期待しているかをまとめる。個々の機能の使い方ではなく、issue が PR になって閉じるまでの流れの中で Monica が担う役割を書く。用語は [CONTEXT.md](../../CONTEXT.md) に従い、決定の背景は [docs/adr](../adr/) に置く。

## 立ち位置

Monica は coding agent の **外側** にいる。コードは書かず、判断もしない。agent が働くための場所を用意し、働いている様子を見え、終わったら片付ける。一言で言えば agent の世話係であり、その世話の対象は今のところ Claude Code のセッションである。

Monica が担うこと:

- GitHub issue を **Task** として取り込み、board に並べる。
- Task に対して **Run** を起こす。worktree を切り、repo の初期化スクリプトを走らせ、terminal tab を開き、hook を注入した agent を起動する。blocked-by の上流が終わっていない Task は起こさない（start gate。`--force` で突破できる）。
- hook を通じて agent の状態を受け取り、board のカードに映す。質問待ち、計画承認待ち、停止、失敗。
- Task に紐づく PR を GitHub から拾い、Draft / Open / Merged をカードに映す。
- Task を閉じるときに worktree と branch を片付ける。

Monica が担わないこと:

- 仕事そのものの正本を持つこと。issue、PR、依存、Epic Brief は GitHub にあり、Monica はそれを読んで映すだけ。
- 何をすべきかを決めること。決めるのはあなたと agent で、Monica は agent が決めやすい状態を整える。
- agent の会話に入ること。Monica は起動と観測を担い、会話の中身は skill が担う。

## 登場人物

| 誰 | 役割 |
|---|---|
| あなた | issue を書き、Run を押し、agent の問いに答え、PR を merge し、Task を閉じる。判断の主体。 |
| coding agent | Run の中で動く Claude Code。issue を実装するときは Worker、Epic flow では Orchestrator にもなる。 |
| skill | agent の手順書。`/tackle` など repo 側のものと、`~/.claude/skills` の汎用のものがある。運用の規定は skill に書かれ、Monica はそれを起動する。 |
| Monica | 上記の世話係。CLI と desktop の 2 つの顔を持つ。 |
| GitHub | issue、PR、sub-issue、blocked-by、Epic Brief の正本。 |

## 正本の分担

| 情報 | 正本 |
|---|---|
| issue、PR、sub-issue の親子、依存、Epic Brief | GitHub |
| Task と Run の状態、terminal tab、通知 | Monica の DB |
| repo 固有のルール（起動プロンプト、初期化、Released の判定など） | 各 repo の `.monica/` 配下 |
| 運用の手順 | skill |

Monica の DB にある GitHub 由来の情報（issue の title と state、PR の状態、親子関係、blocked-by の上流とその状態）は sync で上書きされる写しであり、そこから GitHub に書き戻すことはない。

## 運用の一覧

- [Worker flow](./worker-flow.md): 1 つの issue を 1 つの Task にし、Run を起こして Worker が PR にする。すべての基本。
- [Epic flow](./epic-flow.md): 親 issue を sub-issue に分解し、Orchestrator が着手順と文脈の共有を駆動する。sub-issue ごとに Worker flow を起動する。

## repo 側に置くもの

Monica を使う repo には `.monica/` を置く。`monica project init` が雛形を作る。

| ファイル | 役割 |
|---|---|
| `.monica/prompt.md` | Run 起動時に agent へ渡す初期プロンプト。issue を track した Task でのみ使われる。通常は skill 名 1 行。 |
| `.monica/setup.sh` | worktree を作った直後に走る初期化。依存の取得、ポートの割り当てなど。冪等に書く。 |
| `.monica/epic-flow.md` | Released の判定。default branch への merge が既定で、タグでリリースする repo だけが置く。 |

repo 固有の事情はここに閉じ、Monica 本体と汎用 skill には持ち込まない。
