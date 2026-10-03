---
name: tackle
description: >
  tania の GitHub issue を端から端まで片付けるワークフロー: branch 作成・計画・Fable の subagent によるプラン審査・実装・`/code-review` skill によるレビュー・動作確認・PR 作成まで。`/tackle <#番号 or URL>` で起動。「この issue やって」「#42 を tackle」「issue 片付けて」などのフレーズでも発火する。
model: inherit
---

# tania Issue Tackler

この skill は tania repo を開発するための手順書で、`GLOSSARY.md` の Skill には当たらない。`docs/packages.md` の「`.claude/skills` は生成しない」は Skill についての決まりで、この skill は手で書いて commit する。

## Scope Philosophy

PR は issue に書かれた scope を丸ごと含む。**原則: 1 issue = 1 PR。**

scope を複数 PR に分割してよいのは **運用上の順序制約** がある場合だけ。一方を先に merge しないと壊れるケースを指す。例:

- migration（schema の変更）を先に入れないと、それに依存するコードが動かない
- contract の破壊的な変更を先に出さないと、呼び手が型検査を通らない

**サイズ・ファイル数・レビュー負荷・「関心事が複数」は分割の理由にならない。**

分割が避けられないときは計画（Step 2）で決め、follow-up issue を作って親 issue の sub-issue に紐づける（`docs/agents/issue-tracker.md`）。分割は計画の段階で決めきる。PR 時点の差分が事前の合意なしに issue の scope より小さければ、それは分割ではなく drift なので、残りを終わらせてから PR を作る。

issue が別の slice に回したもの（「骨格 (3) が足す」のような書き方）は、その slice に任せる。

## Workflow

### Step 1: issue の取得と branch

tania の issue は wayfinder が `ready-for-agent` で作るので、tackle は issue の番号か URL から始める。

**1a. issue 番号を決める。**

- 引数が `42`、`#42`、issue の URL なら、その番号を使う。
- 引数が無ければ `git branch --show-current` を見て、`issue-<n>`（`^issue-[0-9]+$`）なら n を使う。
- どちらでもなければ（自由文の引数、`main` などの branch）、issue の番号か URL を訊いて止まる。

**1b. issue と親 issue を読む。**

```bash
gh issue view <n> --json number,title,body,labels,comments,parent
```

本文は「何を作るか / 前提 / 仕様 / 受け入れ条件 / 参照」の節でできている。「前提」の「読むもの」に挙がった docs と ADR は計画の前に開く。「受け入れ条件」が完了の定義になる。

`parent` があれば `gh issue view <親番号> --json title,body` で読む。`parent` が null でも、本文の先頭に `Part of #<n>` があればそれが親になる（sub-issue が使えないときの書き方。`docs/agents/issue-tracker.md`）。親は設計の文脈（slice の並び、blocking、全体の方針）として扱い、scope は当該 issue のものに限る。親の他の子 issue（兄弟）の scope は兄弟に任せる。

**1c. branch を用意する。**

- **`main` の上なら:** `issue-<n>` を切る。Task v1 の Bench の branch と同じ名前なので、tania の Task で tania 自身の issue を扱っても揃う。

  ```bash
  git checkout main && git pull origin main
  git checkout -b issue-<n>
  ```

- **それ以外の branch の上なら:** そのまま居続ける。ユーザーが意図して用意した branch（worktree、作業中、1a で番号を取った `issue-<n>`）で、切り替えると context を失う。

### Step 2: 計画

**まだ plan mode でなければ、最初に `EnterPlanMode` を呼んで plan mode に入る**（`/tackle` の起動時点で plan mode とは限らない。飛ばすと Step 3 のプラン審査と末尾の `ExitPlanMode` が噛み合わず、`ExitPlanMode` が "not in plan mode" で弾かれる）。そのうえで実装計画を作る。

`Plan` subagent で計画を立てるときは、必ず `model="fable"` を明示する（`Agent(subagent_type="Plan", model="fable")`）。

**計画に必ず含めるもの:**

- ロジックを変えるならテスト。必須で例外なし。形は `docs/packages.md` の「テスト」に従う（in-memory の SQLite に migration を当て、外から見える振る舞いを `createRouterClient` で確かめる）。
- schema を変えるなら `bun run generate` の出力を commit する。既存の migration は書き換えず、新しい migration を足す（`docs/packages.md` の「migration」）。

**計画は必ず checklist の節で終わる**（これが実装への契約）:

```markdown
## Checklist

- [ ] 実装完了
- [ ] `bun run check` 通過 — PR 前必須
- [ ] `/code-review low --fix` でコードレビュー — 指摘を全て解消
- [ ] 動作確認（画面・CLI・Shell に触れる変更のとき）
- [ ] `/create-pr` skill で PR 作成
```

状況に応じて項目を足し引きするが、上の該当項目は常に入れる。実装する側は全項目を完了してチェックを付ける。

**動作確認シナリオ（画面・CLI・Shell に触れる変更のとき）:**

issue の「受け入れ条件」から「操作 → 期待結果」を導いて checklist に入れる。期待結果には、操作で変わる表示・出力・DB の状態を具体的に書く。

```markdown
## 動作確認シナリオ

- [ ] CLI: `bun run tania <args>` を実行 → 期待する出力 / DB の状態
- [ ] 画面: tania の窓で X を操作 → Y が表示される
```

各シナリオは「受け入れ条件」の項目と 1:1 で対応させ、issue に書かれた挙動だけを確かめる。

### Step 3: プラン審査（ユーザーに見せる前）

Fable の subagent に、実装プランを tania の codebase と決定に照らして審査させる。目的は設計上クリティカルな問題の早期発見。

`Agent` ツールでレビュアーを 1 体起動する（`model="fable"` を明示する）。`feature-dev:code-architect` は読み取り系ツールしか持たないので、レビュアーがコードを変える余地がない:

```
Agent(subagent_type="feature-dev:code-architect", model="fable"):
  あなたは実装プランのレビュアー。設計の提案ではなく、以下のプランの審査だけを行うこと。

  実装プランを tania のコードベース（このリポジトリ）と、docs/adr/・docs/packages.md・GLOSSARY.md の決定に照らしてレビューせよ。
  プランが言及する既存コードと文書は実際に開いて確認し、推測で判断しないこと。
  nitpick は無視し、設計上クリティカルな問題だけを指摘せよ。特に:
  - domain の slice: 1 つの概念を packages/<domain> の 1 箇所で定義し、層ごとの写し型を作っていないか（ADR-0002）
  - entry の規則と依存の向き: entry は実行環境で切り、依存は task → workbench だけか（docs/packages.md の「entry」）
  - DB の書き手は Backend だけか（ADR-0003、ADR-0011）
  - Shell に置くものは、Tauri プロセスにしか無いものに触る処理と端末の byte だけか（ADR-0001）
  - 語は GLOSSARY.md の定義どおりか。_Avoid_ に挙がった語を使っていないか

  各指摘には根拠となる file:line を添えること。
  クリティカルな問題が無ければ「LGTM」とだけ返すこと。

  <plan>
  （EnterPlanMode が生成したプランの全文をそのまま展開する — 要約しない）
  </plan>
```

subagent の最終メッセージがレビュー本文としてそのまま返ってくる。会話に流すのはその要点だけでよい。

クリティカルな指摘が返ったらプランを直し、再度レビュアーに投げて各修正を検証する。`SendMessage` で同じレビュアーに続きを投げればコンテキストが保持されるので、修正差分だけで判断できる。新しい subagent を起動し直す場合は、前回のレビュー要約を添える。LGTM か残課題なしまで繰り返す。クリティカルな指摘を取り込んでから、ユーザーにプランを提示して承認を得る。

### Step 4: 実装

承認されたプランに従う。

**見た目のある UI を新しく作る場合:**

新規 component / 画面 / layout / 見た目の刷新を伴う変更なら、その UI 部分は `/frontend-design:frontend-design` skill を起動して作る（既存ロジックの配線・状態の修正・小さな CSS の調整は通常の実装で進める）。skill には issue の「仕様」と「受け入れ条件」から導いた「何を・どう見せるか」を渡し、既存の UI のトーンと部品に揃えるよう指示する。置き場所は `docs/packages.md` に従う（domain の UI は `packages/<d>/src/ui`、domain の語を持たない部品は `packages/ui`）。

**ルール:**

- 触った範囲のテストを回しながら進める（`bun test <file>`、`cargo test -p <crate>`）
- format の崩れは `bunx oxfmt` で直す

### Step 5: コードレビュー

実装完了・`bun run check` 通過の後、`/code-review low --fix` skill を起動して差分をレビューする。

指摘を全て解消するまで修正 → 再レビューを繰り返す。修正したら `bun run check` を回し直す。

`/code-review` が見ない tania 固有の観点は自分で確認する:

- 新しく足した・変えた procedure と domain の method ごとに、外から見える振る舞いのテストが揃っているか
- domain をまたぐ書き込みが相手の domain の method を通っているか、apps がロジックを持たず packages を組み立てるだけになっているか（`docs/packages.md` の「domain をまたぐ規則」、ADR-0002）

**この Step は PR 作成をブロックする。** レビュー指摘が全て解消するまで、動作確認・PR に進まない。

### Step 6: 動作確認

- **CLI**: `bun run desktop` で Backend を立て、`bun run tania <args>` で該当の command を実行して出力と DB の状態を確認する。CLI は Backend が居ないと exit 2 で終わる（ADR-0007）。`bun run check` のテストだけで受け入れ条件を確かめられるなら、画面は要らない。
- **画面 / Shell**: `bun run desktop` で tania の窓と vite を起動し、debug build に入っている mcp-bridge 経由で tauri-mcp の tool（`webview_*` / `ipc_*`）を使って「操作 → 期待結果」を確認する。dev server は常駐していないので、起動も確認手順の一部。

一時的な `TANIA_HOME` で確かめるときは、`TANIA_HOME=~/.tania-p25 bun run desktop` のように短い path にし、`bun run tania` にも同じ値を渡す。ptyd の socket（`$TANIA_HOME/ptyd.sock`）の path が macOS の上限 104 byte を超えると bind できず、client には ENOENT にしか見えない。

端末に Enter を送るときは、tool の press ではなく、`keyCode: 13` 付きの keydown を `.xterm-helper-textarea` に JS で dispatch するか、`terminal_write` に `\r` を送る。xterm は tool の press の Enter を受け取らない。

### Step 7: checklist を完了する

プランの checklist を **順番どおり** に消化する。各項目は完了してチェックを付ける。

**実行順は厳格:**

1. 実装完了
2. `bun run check` 通過（PR 前必須）
3. **コードレビュー**（`/code-review low --fix`）— 指摘を全て解消
4. **動作確認**（画面・CLI・Shell に触れる変更のとき）— push / PR の前に必ず
5. commit & push → `/create-pr` skill で PR 作成

push と PR は動作確認の後に行う。`/create-pr` は branch 名が `issue-<n>` なら本文に `close #<n>` を自動で入れるので、merge 時に issue が自動で閉じる。

---

## Gotchas

苦労して得た教訓。各 `/tackle` 実行前に読む — どれも見落としやすい。

### プラン審査の load-bearing な主張は鵜呑みにせず該当コードを自分で読む

Step 3 のレビュアーは `file:line` を指して既存コードの性質を主張することがある（*「この関数は X を保証しない」* 等）。その主張は **load-bearing** — 外すと提案された修正が不要・有害になる。取り込む前に該当箇所を自分で開いて確認する。正しければ反映し、過剰な主張なら次の投げで実コードを添えて反論し、存在しないリスクへの補償を発明しない。判断できなければプランの Open Questions に書き、実装前に検証する。

### 計画修正時は checklist を本文と同期させる

プランの checklist は実装への拘束力ある契約。プラン審査で本文のあるセクションを直したら、**同じ edit で** checklist も直す。本文が「procedure を足さず既存の method を使う」になっているのに checklist に「procedure を追加」が残ると、実装側は checklist に従って誤った設計を出荷する。「どのファイルを作る/変えるか」「どの不変条件を立てるか」を触る本文変更は、必ず checklist の差分とセットにする。動作確認・テスト一覧のセクションも同様。

### plan mode でもプラン審査を飛ばさない

plan mode の「非 readonly ツール禁止」は Step 3 のプラン審査を免除しない。審査は計画フェーズの一部で、ユーザーは `/tackle` を打った時点でそれに同意している。レビュアー subagent は読み取り専用なので plan mode と矛盾しない。`ExitPlanMode` の前に審査を回し、Step 3 のとおり反復する。それからユーザーにプランを見せる。
