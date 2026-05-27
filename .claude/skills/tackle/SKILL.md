---
name: tackle
description: >
  GitHub Issue を端から端まで片付けるワークフロー（`/issue` の個人版）: ブランチ作成・計画・
  `/codex` によるプラン審査・実装・`feature-dev:code-reviewer` による
  レビュー・PR 作成まで。`/tackle <URL or #番号>` で起動。「この issue やって」「#16 を tackle」
  「issue 片付けて」などのフレーズでも発火する。monica の Rust workspace + Tauri 構成に合わせてある。
model: inherit
---

# Monica Issue Tackler

## Scope Philosophy

PR は Issue に書かれた scope を丸ごと含む。**原則: 1 PR = Issue の全 scope。**

scope を複数 PR に分割してよいのは **運用上の順序制約** がある場合だけ — つまり一方を先に merge / 反映しないと壊れるケース。例:

- マイグレーション（schema 変更）を先に入れないと、それに依存するコードが動かない
- 破壊的な API 変更を先に出さないと利用側がコンパイルできない

**サイズ・ファイル数・レビュー負荷・「関心事が複数」では分割しない。** monica では分割理由にならない。

分割が避けられないときは計画フェーズ（Step 2）で決め、`gh sub-issue create --parent <N>` で follow-up issue を先に切る。実装中に後付けで分割しない。PR 時点の差分が事前合意なしに Issue scope より小さければ、それは分割ではなく drift — 残りを終わらせてから PR を作る。

## Workflow

### Step 1: Issue 番号の解決・取得・ブランチ作成

**1a. Issue 番号を解決する。**

- **引数で Issue 番号や URL を渡された場合:** それをそのまま使う。
- **引数が無い場合:** 現在のブランチ名にフォールバックする。

  ```bash
  git branch --show-current
  ```

  - ブランチ名が **純数値**（`^[0-9]+$`、例 `15`）なら、それを Issue 番号として使う。monica の作業ブランチは `15`・`14` のように Issue 番号そのものを名前にする規約なので、この前提が成立する。
  - それ以外（`main`、`feature/15`、`foo` など）は、Issue 番号を明示するよう求めて中断する。`feature/N` 等から数字を抜き出そうとしない — フォールバックは意図的に厳格にする。

**1b. Issue を取得する。**

```bash
gh issue view <issue-番号-or-URL> --json number,title,body,labels,comments
```

Issue template（`Context / Goal / Out of Scope / Acceptance Criteria / Verification`）の各セクションを読み取る。特に **Out of Scope** は scope を勝手に広げないための制約として尊重する。

**1c. ブランチ処理。**

`git branch --show-current` で現在のブランチを確認する。

- **`main` 上の場合:** 新しい作業ブランチを切る。ブランチ名は Issue 番号そのもの（monica の規約）。
  ```bash
  git checkout main && git pull origin main
  git checkout -b <issue-番号>
  ```
- **それ以外のブランチ上の場合:** そのまま居続ける — `git checkout` しない。ユーザーが意図的に用意したブランチ（worktree、作業中、前 Issue の続き、1a で解決した数値ブランチ）であり、新規ブランチを切ると context を失う。

### Step 2: 計画

`EnterPlanMode` ツールで実装計画を作る。

**計画に必ず含めるもの:**

- ロジックを変更するときはテスト — 必須・例外なし
- schema を変更するなら `migrations.rs` にマイグレーションを 1 ステップ追加（既存 migration の改変ではなく追記）。`PROGRESS.md` の M0 設計（DB=rusqlite/SQLite）と整合させる

**計画は必ず checklist セクションで終わる**（これが実装エージェントへの契約）:

```markdown
## Checklist

- [ ] 実装完了
- [ ] テスト通過（`just test`）
- [ ] `just check` 通過（oxlint + oxfmt --check + clippy -D warnings）— PR 前必須
- [ ] `feature-dev:code-reviewer` でコードレビュー — 指摘を全て解消 - **monica-core 変更時:** 新規/変更した公開関数の unit test + 回帰テストを 100% 確認
- [ ] PROGRESS.md 更新（Timeline に 1 行追記 / Todo を更新）
- [ ] UI 動作確認（フロント変更がある場合）— `verify` skill / Tauri MCP で
- [ ] `/create-pr` skill で PR 作成
```

状況に応じて項目を足し引きするが、上記の該当項目は常に入れる。実装エージェントは全項目を完了してチェックを付ける義務がある。

**`PROGRESS.md` 更新は monica の契約**: CLAUDE.md が「機能を追加・変更したら必ず `PROGRESS.md` を更新」と明記している。Timeline は `- YYYY-MM-DD 何をしたか（なぜ）` 形式で 1〜2 行、末尾に追記。完了した Todo は Timeline へ 1 行で移す。これを checklist から落とさない。

**動作確認シナリオ（フロント変更がある場合）:**

Issue の Acceptance Criteria / Verification から「操作 → 期待結果」を具体的に導いて checklist に入れる。「画面が表示される」レベルでは書かない。

```markdown
## 動作確認シナリオ

- [ ] CLI 機能: `./monica <subcommand> ...` を実行 → 期待する出力 / DB 状態
- [ ] GUI 機能: Tauri ウィンドウで X を操作 → Y が表示される
```

各シナリオは Issue の spec 項目と 1:1 で対応させる。Issue に書かれていない挙動のシナリオを発明しない。

### Step 3: プラン審査（ユーザーに見せる前）

`/codex` を使って、実装プランを monica のコードベースに照らして審査する。プラン審査は「設計上クリティカルな問題の早期発見」が目的。

```
cat <<'EOF' | codex exec -
  以下の実装プランを monica のコードベースに照らしてレビューせよ。
  nitpick は無視し、設計上クリティカルな問題だけを指摘せよ。
  特に: crates 間の責務分担（core / cli / app）、WorkItem/Run/Event モデルとの整合、
  migration の前方互換、CLI コマンドの命名・既存規約との一貫性。

  <plan>
  $(EnterPlanMode が生成したプラン)
  </plan>
EOF
```

クリティカルな指摘が返ったらプランを直し、前回のレビュー要約を添えて再度 `/codex` に投げ、各修正を検証する。LGTM か残課題なしまで繰り返す。クリティカルな指摘を取り込んでから、ユーザーにプランを提示して承認を得る。

### Step 4: 実装

承認されたプランに従う。

**ルール:**

- ロジックが変わったらテストを足す
- `just test` でテスト通過を確認
- コメントは「なぜ」が非自明な場合のみ（CLAUDE.md）

### Step 5: コードレビュー

実装完了・テスト通過後に 2 フェーズのレビューを回す。

**Phase A: テストカバレッジ強制**（コアロジックを変更した場合）

専用のカバレッジレビュアーを起動する:

```
Agent(subagent_type="feature-dev:code-reviewer"):
  Focus: monica-core 変更の unit test / 回帰テスト網羅性
  全 core 差分（committed + staged + unstaged）をレビュー:
  - git diff main...HEAD
  - git diff --cached
  - git diff

  store.rs / model.rs / migrations.rs の新規・変更した公開関数・分岐ごとに:
  1. 対応する unit test が存在し、変更を覆っているか
  2. バグ修正には回帰テストがあるか（修正前なら fail するテスト）

  confidence=100 で flag するもの:
  - テストの無い新規公開関数
  - 既存/新規テストで覆われていない変更
  - 回帰テストの無いバグ修正
  - error path / 境界条件の未カバレッジ
```

足りないテストを全て埋めてから進む。`just test` を再実行。

**Phase B: 一般コードレビュー**

`feature-dev:code-reviewer` を 3 並列で、焦点を変えて起動する: ①簡潔さ/DRY/設計、②バグ/機能的正しさ、③プロジェクト規約/抽象。

指摘を集約し、confidence ≥ 80 のものだけ対応する。クリティカルを直し、必要ならテストを再実行する。

**この Step は PR 作成をブロックする。** レビュー指摘が全て解消するまで、動作確認・PR に進まない。

### Step 6: 動作確認

- **CLI 機能**（M0 の `monica project` / `issue` 系など）: `just dev` でデバッグ版 `./monica` をビルドし、該当サブコマンドを実行して出力と DB 状態を確認する。`just test` だけで足りるなら GUI は不要。
- **GUI / フロント変更**: `just dev` で Tauri ウィンドウ + Vite を起動し、`verify` skill か Tauri MCP（`webview_*` / `ipc_*` ツール）で「操作 → 期待結果」を確認する。hello_pay と違い monica では dev サーバーが常駐していないので、起動も確認手順の一部。

### Step 7: checklist を完了する

プランの checklist を **順番どおり** に消化する。各項目は完了してチェックを付ける。

**実行順は厳格:**

1. 実装完了
2. テスト通過（`just test`）
3. `just check` 通過（PR 前必須）
4. **コードレビュー**（`feature-dev:code-reviewer`）— 指摘を全て解消
5. **動作確認**（フロント変更があれば）— push / PR の前に必ず
6. **PROGRESS.md 更新**（Timeline 1 行 / Todo）
7. commit & push → `/create-pr` skill で PR 作成

動作確認・`PROGRESS.md` 更新の前に push / PR を作らない。`/create-pr` はブランチ名が純数値なら body に `close #<番号>` を自動で入れるので、ブランチ名を Issue 番号にしておけば merge 時に Issue が自動クローズされる。

---

## Gotchas

苦労して得た教訓。各 `/tackle` 実行前に読む — どれも見落としやすい。

### `PROGRESS.md` 更新を checklist から落とさない

monica の CLAUDE.md は「機能を追加・変更したら必ず `PROGRESS.md` を更新」を契約にしている。hello_pay には無い monica 固有の要求なので、プランの checklist に明示しないと実装エージェントが必ず取りこぼす。Timeline 追記は `- YYYY-MM-DD 何をしたか（なぜ）` 1 行、完了 Todo は `## Todo` から消して Timeline に移す。方向性が変わったら `## 向かう先` も直す。

### `just check` は PR 前必須

`just check` = oxlint + oxfmt --check + `cargo clippy --workspace --all-targets -- -D warnings`。clippy は `-D warnings` なので warning が 1 つでもあると CI ではなくローカルで落ちる。CI（`.github/workflows/ci.yml`）は lint + tauri build しか回さず **テストは回さない** ので、`just test` はローカルで通すのが自分の責任。`fmt` は `bunx oxfmt`（チェックだけなら `bunx oxfmt --check`）。

### `/codex` レビューの load-bearing な主張は鵜呑みにせず該当コードを自分で読む

Step 3 の `/codex` レビューでは `file:line` を指して既存コードの性質を主張することがある（*「この関数は X を保証しない」*等）。その主張は **load-bearing** — 外すと提案された修正が不要・有害になる。取り込む前に該当箇所を自分で開いて確認する。正しければ反映、過剰主張なら次の投げで実コードを添えて反論し、存在しないリスクへの補償を発明しない。判断できなければプランの Open Questions に書き、実装前に検証する。

### 計画修正時は checklist を本文と同期させる

プランの checklist は実装エージェントへの拘束力ある契約。`/codex` レビューで本文のあるセクションを直したら、**同じ edit で** checklist も直す。本文が「migration をやめた」になっているのに checklist に「migration を追加」が残ると、実装側は checklist に従って誤った設計を出荷する。「どのファイルを作る/変えるか」「どの不変条件を立てるか」を触る本文変更は、必ず checklist の差分とセットにする。動作確認・テスト一覧のセクションも同様。

### crates の責務境界を越える設計をしない

DB アクセスやドメインロジックは共有コア層に置き、インターフェース層（CLI / GUI）はそれを呼ぶだけにする。CLI に直接 SQL を書く、GUI にコア相当のロジックを置く、といった設計はこの方針に反するので Step 3 で必ず弾く。

### plan mode でもプラン審査を飛ばさない

plan mode の「非 readonly ツール禁止」は Step 3 の `/codex` 審査を免除しない。審査は計画フェーズの一部で、ユーザーは `/tackle` を打った時点でそれに同意している。`ExitPlanMode` の前に `/codex` 審査を回し、Step 3 のとおり反復する。それからユーザーにプランを見せる。
