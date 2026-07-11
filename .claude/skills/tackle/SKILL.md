---
name: tackle
description: >
  GitHub Issue を端から端まで片付けるワークフロー: ブランチ作成・計画・Fable 5 subagent によるプラン審査・実装・`/code-review` skill によるレビュー・PR 作成まで。`/tackle <URL or #番号>` で起動。「この issue やって」「#16 を tackle」
  「issue 片付けて」などのフレーズでも発火する。Issue 番号の代わりに機能説明テキストを渡すと、
  Issue を先に作成してから対応を開始する。monica の Rust workspace + Tauri 構成に合わせてある。
model: inherit
---

# Monica Issue Tackler

## Scope Philosophy

PR は Issue に書かれた scope を丸ごと含む。**原則: 1 PR = Issue の全 scope。**

scope を複数 PR に分割してよいのは **運用上の順序制約** がある場合だけ — つまり一方を先に merge / 反映しないと壊れるケース。例:

- マイグレーション（schema 変更）を先に入れないと、それに依存するコードが動かない
- 破壊的な API 変更を先に出さないと利用側がコンパイルできない

**サイズ・ファイル数・レビュー負荷・「関心事が複数」では分割しない。** monica では分割理由にならない。

分割が避けられないときは計画フェーズ（Step 3）で決め、`gh sub-issue create --parent <N>` で follow-up issue を先に切る。実装中に後付けで分割しない。PR 時点の差分が事前合意なしに Issue scope より小さければ、それは分割ではなく drift — 残りを終わらせてから PR を作る。

## Workflow

### Step 1: Issue 作成（機能説明テキストが渡された場合のみ）

引数が Issue 番号/URL ではなく自由文の機能説明テキストだった場合、まず GitHub Issue を作成する。

**1a. Issue body を構成する。**

ユーザーが渡したテキストを元に、Issue テンプレート（`.github/ISSUE_TEMPLATE/monica_task.md`）のセクション構造に沿って body を生成する:

- **Context**: ユーザーのテキストから背景・動機を抽出。不足していれば簡潔に補完する
- **Goal**: 完了条件を明示する
- **Out of Scope**: テキストに含まれていない機能拡張を明記して scope を制限する
- **Acceptance Criteria**: 具体的なチェックリスト
- **Verification**: 確認方法（テストコマンド / 手動確認手順）

**1b. Issue タイトルを決める。**

テキストの要旨を 1 行に凝縮する。簡潔かつ具体的に（例: `Space キーでタスク行のコンテキストメニューを表示する`）。

**1c. Issue を作成し、ユーザーに確認する。**

作成前に、タイトルと body をユーザーに提示して確認を取る。承認されたら:

```bash
gh issue create --title "<タイトル>" --body "<body>"
```

作成された Issue 番号を控え、以降の Step 2 にその番号を渡す。Step 2 は通常どおり Issue 取得 → ブランチ作成と進む。

### Step 2: Issue 番号の解決・取得・ブランチ作成

**2a. Issue 番号を解決する。**

引数の形式で 3 つのパスに分岐する:

- **引数で Issue 番号や URL を渡された場合:** それをそのまま使う。
- **引数で機能説明テキストが渡された場合（番号でも URL でもない自由文）:** → **Step 1: Issue 作成** に進む。
- **引数が無い場合:** 現在のブランチ名にフォールバックする。

  ```bash
  git branch --show-current
  ```

  - ブランチ名が **純数値**（`^[0-9]+$`、例 `15`）または **`issue-<番号>`**（`^issue-[0-9]+$`、例 `issue-116`）なら、その数値部分を Issue 番号として使う。monica の作業ブランチは Issue 番号そのもの（`15`・`14`）か、worktree 運用時の `issue-<番号>` を名前にする規約なので、この前提が成立する。
  - それ以外（`main`、`feature/15`、`foo` など）は、Issue 番号を明示するよう求めて中断する。`feature/N` 等から数字を抜き出そうとしない — フォールバックは上記 2 形式に意図的に限定する。

判定ルール: 引数が純数値（`^[0-9]+$`）、`#数字`（`^#[0-9]+$`）、または GitHub Issue URL（`https://github.com/.*/issues/[0-9]+`）にマッチすれば Issue 番号/URL。それ以外はすべて機能説明テキストとして扱う。

**2b. Issue を取得する。**

```bash
gh issue view <issue-番号-or-URL> --json number,title,body,labels,comments
```

Issue template（`Context / Goal / Out of Scope / Acceptance Criteria / Verification`）の各セクションを読み取る。特に **Out of Scope** は scope を勝手に広げないための制約として尊重する。

**2c. 親 issue があれば取得する。**

`gh issue view --json` には `parent` フィールドが無いので、GraphQL の `Issue.parent` で親を逆引きする（Sub-issues リンクが張られている場合のみ非 null。body の `Part of #N` という文言だけではリンクされていないことがある — その場合は body 中の参照を手掛かりに親番号を特定する）:

```bash
gh api graphql -f query='query { repository(owner: "ashigirl96", name: "monica") { issue(number: <issue-番号>) { parent { number title url } } } }' --jq '.data.repository.issue.parent'
```

親が見つかったら、その親も `gh issue view <親番号> --json title,body` で取得して読む。親 issue は設計判断・データモデル・全体構成などの **設計コンテキスト**として扱う — 子 issue の body が親を参照している場合（「スキーマは親 issue 参照」等）、親を読まないと計画が成立しない。ただし scope はあくまで当該子 issue のもの。**親の他の子 issue（兄弟）のスコープには踏み込まない。**

**2d. ブランチ処理。**

`git branch --show-current` で現在のブランチを確認する。

- **`main` 上の場合:** 新しい作業ブランチを切る。ブランチ名は Issue 番号そのもの（monica の規約）。
  ```bash
  git checkout main && git pull origin main
  git checkout -b <issue-番号>
  ```
- **それ以外のブランチ上の場合:** そのまま居続ける — `git checkout` しない。ユーザーが意図的に用意したブランチ（worktree、作業中、前 Issue の続き、1a で解決した数値ブランチ）であり、新規ブランチを切ると context を失う。

### Step 3: 計画

**まだ plan mode でなければ、最初に `EnterPlanMode` を呼んで plan mode に入る**（`/tackle` 起動時点で plan mode とは限らない。飛ばすと Step 4 のプラン審査や末尾の `ExitPlanMode` が plan mode 前提で噛み合わず、`ExitPlanMode` が "not in plan mode" で弾かれる）。そのうえで実装計画を作る。

plan mode 中に `Plan` subagent を起動して計画を立てる場合は、必ず `model="fable"` を明示する（`Agent(subagent_type="Plan", model="fable")`）。

**計画に必ず含めるもの:**

- ロジックを変更するときはテスト — 必須・例外なし
- schema を変更するなら `migrations.rs` にマイグレーションを 1 ステップ追加（既存 migration の改変ではなく追記）。DB=rusqlite/SQLite の設計と整合させる

**計画は必ず checklist セクションで終わる**（これが実装エージェントへの契約）:

```markdown
## Checklist

- [ ] 実装完了
- [ ] テスト通過（`just test`）
- [ ] `just check` 通過（oxlint + oxfmt --check + clippy -D warnings）— PR 前必須
- [ ] `/code-review` skill でコードレビュー — 指摘を全て解消 - **monica-core 変更時:** 新規/変更した公開関数の unit test + 回帰テストを 100% 確認
- [ ] UI 動作確認（フロント変更がある場合）— `verify` skill / Tauri MCP で
- [ ] `/create-pr` skill で PR 作成
```

状況に応じて項目を足し引きするが、上記の該当項目は常に入れる。実装エージェントは全項目を完了してチェックを付ける義務がある。

**動作確認シナリオ（フロント変更がある場合）:**

Issue の Acceptance Criteria / Verification から「操作 → 期待結果」を具体的に導いて checklist に入れる。「画面が表示される」レベルでは書かない。

```markdown
## 動作確認シナリオ

- [ ] CLI 機能: `./monica <subcommand> ...` を実行 → 期待する出力 / DB 状態
- [ ] GUI 機能: Tauri ウィンドウで X を操作 → Y が表示される
```

各シナリオは Issue の spec 項目と 1:1 で対応させる。Issue に書かれていない挙動のシナリオを発明しない。

### Step 4: プラン審査（ユーザーに見せる前）

Fable 5 の subagent を使って、実装プランを monica のコードベースに照らして審査する。プラン審査は「設計上クリティカルな問題の早期発見」が目的。

`Agent` ツールでレビュアーを 1 体起動する（`model="fable"` を明示する）。`feature-dev:code-architect` は読み取り系ツールしか持たないので、レビュアーが誤ってコードを変更する余地がない:

```
Agent(subagent_type="feature-dev:code-architect", model="fable"):
  あなたは実装プランのレビュアー。設計の提案ではなく、以下のプランの審査だけを行うこと。

  実装プランを monica のコードベース（このリポジトリ）に照らしてレビューせよ。
  プランが言及する既存コードは実際にファイルを開いて確認し、推測で判断しないこと。
  nitpick は無視し、設計上クリティカルな問題だけを指摘せよ。
  特に: crates 間の責務分担（core / cli / app）、WorkItem/Run/Event モデルとの整合、
  migration の前方互換、CLI コマンドの命名・既存規約との一貫性。

  各指摘には根拠となる file:line を添えること。
  クリティカルな問題が無ければ「LGTM」とだけ返すこと。

  <plan>
  （EnterPlanMode が生成したプランの全文をそのまま展開する — 要約しない）
  </plan>
```

subagent の最終メッセージがレビュー本文としてそのまま返ってくる。会話に流すのはその要点だけでよい。

クリティカルな指摘が返ったらプランを直し、再度レビュアーに投げて各修正を検証する。`SendMessage` で同じレビュアーに続きを投げればコンテキストが保持されるので修正差分だけで判断できる。新しい subagent を起動し直す場合は、前回のレビュー要約を添える。LGTM か残課題なしまで繰り返す。クリティカルな指摘を取り込んでから、ユーザーにプランを提示して承認を得る。

### Step 5: 実装

承認されたプランに従う。

**視覚的フロント影響がある場合:**

新規コンポーネント / ページ / レイアウト / 見た目の刷新を伴う変更なら、その UI 部分は自前でアドホックに書かず `/frontend-design:frontend-design` skill を起動して作る（既存ロジックの配線・状態修正・小さな CSS 微調整は対象外 — 通常実装で進める）。skill には Issue の Acceptance Criteria / Verification から導いた「何を・どう見せるか」を渡し、monica 既存の UI トーン・コンポーネント規約に揃えるよう指示する。生成物も Monica 規約（型は Rust が single source of truth・判定ロジックはコア側・`just fmt`）に必ず通す。

**ルール:**

- ロジックが変わったらテストを足す
- `just test` でテスト通過を確認
- コメントは「なぜ」が非自明な場合のみ（CLAUDE.md）

### Step 6: コードレビュー

実装完了・テスト通過後、`/code-review` skill を起動して差分をレビューする（Skill tool で `code-review` を invoke）。

指摘を全て解消するまで修正 → 再レビューを繰り返す。修正したら `just test` を再実行する。

`/code-review` が見ない monica 固有の観点は自分で確認する:

- **monica-core 変更時:** 新規/変更した公開関数・分岐ごとに unit test / 回帰テストが揃っているか
- 依存方向が一方向か: cli/app → core（Rust）、components → hooks/atoms → bindings（フロント）。
  ビジネスルールが core に閉じているか、bindings.ts を迂回した型の二重定義がないか

**この Step は PR 作成をブロックする。** レビュー指摘が全て解消するまで、動作確認・PR に進まない。

### Step 7: 動作確認

- **CLI 機能**（M0 の `monica project` / `issue` 系など）: `just dev` でデバッグ版 `./monica` をビルドし、該当サブコマンドを実行して出力と DB 状態を確認する。`just test` だけで足りるなら GUI は不要。
- **GUI / フロント変更**: `just dev` で Tauri ウィンドウ + Vite を起動し、`verify` skill か Tauri MCP（`webview_*` / `ipc_*` ツール）で「操作 → 期待結果」を確認する。hello_pay と違い monica では dev サーバーが常駐していないので、起動も確認手順の一部。

### Step 8: checklist を完了する

プランの checklist を **順番どおり** に消化する。各項目は完了してチェックを付ける。

**実行順は厳格:**

1. 実装完了
2. テスト通過（`just test`）
3. `just check` 通過（PR 前必須）
4. **コードレビュー**（`/code-review` skill）— 指摘を全て解消
5. **動作確認**（フロント変更があれば）— push / PR の前に必ず
6. commit & push → `/create-pr` skill で PR 作成

動作確認の前に push / PR を作らない。`/create-pr` はブランチ名が純数値か `issue-<番号>` なら body に `close #<番号>` を自動で入れるので、ブランチ名を Issue 番号にしておけば merge 時に Issue が自動クローズされる。

---

## Gotchas

苦労して得た教訓。各 `/tackle` 実行前に読む — どれも見落としやすい。

### `just check` は PR 前必須

`just check` = oxlint + oxfmt --check + `cargo clippy --workspace --all-targets -- -D warnings`。clippy は `-D warnings` なので warning が 1 つでもあると CI ではなくローカルで落ちる。CI（`.github/workflows/ci.yml`）は lint + tauri build しか回さず **テストは回さない** ので、`just test` はローカルで通すのが自分の責任。`fmt` は `bunx oxfmt`（チェックだけなら `bunx oxfmt --check`）。

### プラン審査の load-bearing な主張は鵜呑みにせず該当コードを自分で読む

Step 4 のレビュアーは `file:line` を指して既存コードの性質を主張することがある（*「この関数は X を保証しない」*等）。その主張は **load-bearing** — 外すと提案された修正が不要・有害になる。取り込む前に該当箇所を自分で開いて確認する。正しければ反映、過剰主張なら次の投げで実コードを添えて反論し、存在しないリスクへの補償を発明しない。判断できなければプランの Open Questions に書き、実装前に検証する。

### 計画修正時は checklist を本文と同期させる

プランの checklist は実装エージェントへの拘束力ある契約。プラン審査で本文のあるセクションを直したら、**同じ edit で** checklist も直す。本文が「migration をやめた」になっているのに checklist に「migration を追加」が残ると、実装側は checklist に従って誤った設計を出荷する。「どのファイルを作る/変えるか」「どの不変条件を立てるか」を触る本文変更は、必ず checklist の差分とセットにする。動作確認・テスト一覧のセクションも同様。

### crates の責務境界を越える設計をしない

DB アクセスやドメインロジックは共有コア層に置き、インターフェース層（CLI / GUI）はそれを呼ぶだけにする。CLI に直接 SQL を書く、GUI にコア相当のロジックを置く、といった設計はこの方針に反するので Step 4 で必ず弾く。

### plan mode でもプラン審査を飛ばさない

plan mode の「非 readonly ツール禁止」は Step 4 のプラン審査を免除しない。審査は計画フェーズの一部で、ユーザーは `/tackle` を打った時点でそれに同意している。レビュアー subagent は読み取り専用なので plan mode と矛盾しない。`ExitPlanMode` の前に審査を回し、Step 4 のとおり反復する。それからユーザーにプランを見せる。
