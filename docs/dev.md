# monica 開発ガイド

開発時に守るべき原則と、依存・コマンド・コードを追加するときの手順をまとめたチェックリスト。本プロジェクトは配布バイナリのサイズを膨らませないことを最優先の設計制約とする。**追加で開発するときもこの方針を崩さない**ことが目的。

---

## 0. 基本前提

| 要素                              | 採用                                                                 |
| --------------------------------- | -------------------------------------------------------------------- |
| デスクトップシェル                | Tauri 2（手書きスキャフォールド）                                    |
| パッケージマネージャ / ランタイム | Bun（`bun --bun vite` で Vite を Bun ランタイム実行）                |
| フロントエンド                    | React 19 + TypeScript + Vite 6                                       |
| スタイリング                      | Tailwind CSS v4 + `@tailwindcss/vite` + shadcn/ui (`new-york` style) |
| Lint / Format                     | oxlint + oxfmt（`.oxlintrc.json` / `.oxfmtrc.json`）                 |
| 可視化                            | rollup-plugin-visualizer（`just analyze` のときだけロード）          |
| コマンドランナー                  | just（`justfile`）                                                   |
| App identifier                    | `com.ashigirl96.monica`、productName: `monica`                       |

> Tauri 2 を選んだ時点で Chromium を同梱せず、OS の WebView（macOS: WKWebView / Windows: WebView2 / Linux: WebKitGTK）を借りる構造。Electron 比で 10 倍以上のサイズ差がすでについている。本書はそこから**さらに 1/3 〜 1/5 に絞る**ためのガイド。

---

## 1. Rust release profile — "Five Aces"（ワークスペース root の `Cargo.toml`）

`[profile.release]` の **5 項目すべて** が入っていることが前提。1 つでも欠けると目に見えてサイズが増える。

```toml
[profile.release]
codegen-units = 1   # クロスモジュール最適化を有効化
lto = "fat"         # Link-Time Optimization (-20〜30%)
opt-level = "s"     # サイズ最適化 ("3" は速度優先)
panic = "abort"     # スタック巻き戻しコード除去 (-数百KB)
strip = true        # デバッグシンボル除去
```

| 設定                | 効果                                         |
| ------------------- | -------------------------------------------- |
| `lto = "fat"`       | 全クレート横断のインライン化・dead code 除去 |
| `opt-level = "s"`   | サイズ重視のインライン制御                   |
| `codegen-units = 1` | LTO の効きを最大化                           |
| `panic = "abort"`   | unwinder メタデータを削除                    |
| `strip = true`      | symbol table 除去                            |

トレードオフ: release ビルド時間とインクリメンタル性が悪化する。**`[profile.dev]` 側は `incremental = true` のまま**にしておくこと。

実装: ワークスペース root の `Cargo.toml`。profile はメンバー crate（`crates/monica-app` など）側に書いても Cargo に無視されるため、必ず root に置く。

---

## 2. Rust 依存クレートの引き締め

### 2.1 `default-features = false` を必ず付ける

主要クレートはデフォルトで重い feature を有効にしている。**default を消し、必要な feature だけ列挙する**。

monica の既存依存はこの方針で書かれている:

```toml
tauri = { version = "2", default-features = false, features = ["wry"] }
serde = { version = "1", default-features = false, features = ["derive"] }
serde_json = { version = "1", default-features = false, features = ["std"] }
```

### 2.2 新しいクレートを追加するときの手順

1. `default-features = false` を必ず付ける
2. README / docs.rs で feature 一覧を確認
3. **使う機能だけ** を `features = [...]` に列挙
4. プラットフォーム別 native API があれば `[target.'cfg(target_os = "macos")'.dependencies]` で分岐
5. `just bloat` を走らせて、追加前後でバイナリサイズの差を確認

### 2.3 「これ標準ライブラリで書けない？」を毎回問う

- `lazy_static` → `std::sync::OnceLock`
- 軽い regex → `regex-lite`
- 簡単な JSON → 手書きパース or `serde_json` の最小 feature

---

## 3. Tauri 設定（`crates/monica-app/tauri.conf.json`）

### 3.1 `removeUnusedCommands` は **必ず ON**

```json
{
  "build": {
    "removeUnusedCommands": true
  }
}
```

これだけで、**フロントが `invoke()` していない `#[tauri::command]` をビルド時に削除**してくれる。monica の初回 build ログでは、Tauri 内蔵コマンドだけで 70 個近くが削られている（`app_show`, `create_webview_window`, `set_window_*` 等）。

### 3.2 プラグインの追加は要検討

`tauri-plugin-*` を追加するときは:

- 必要な feature だけにする（`default-features = false`）
- そもそも plugin 経由でなく、自前で `#[tauri::command]` を書いた方が小さくならないか検討
- plugin を入れたら `capabilities/default.json` の `permissions` も忘れず更新

---

## 4. フロントエンドビルド（`vite.config.ts`）

### 4.1 `manualChunks` で重い依存を分割

```ts
build: {
  rollupOptions: {
    output: {
      manualChunks(id) {
        if (!id.includes("node_modules")) return;
        if (id.includes("@radix-ui/")) return "radix";
        if (id.includes("react-dom")) return "react-dom";
        // 新しい重量級依存はここに追加
      },
    },
  },
}
```

**チャンク分割だけではサイズは減らない**（合計バイト数は同じ）。重要なのは「実際に触らない機能の chunk は読み込まれない」こと。`§5 動的 import` とセットで初めて効く。

### 4.2 esbuild で本番から `console.debug/info/trace` を削除

```ts
esbuild: {
  drop: mode === "production" ? ["debugger"] : [],
  pure: mode === "production"
    ? ["console.debug", "console.info", "console.trace"]
    : [],
}
```

`pure` 指定した関数は**副作用無しと見なされ、戻り値が未使用なら呼び出しごと削除**される。`console.log` を残すかは要件次第。本番でデバッグ出力を残したいときは `console.debug` 等に置き換える運用。

### 4.3 ビルドターゲットは ES2022 以上

```ts
build: {
  target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome120" : "es2022",
}
```

Tauri は OS の WebView を使うので、`es2015` 等の古いターゲットを指定する必要はない。古いターゲットは async/await や class field を polyfill して膨らむだけ。

---

## 5. アプリ設計層 — 動的 import の使い分け

### 5.1 「条件分岐の先にある依存」は **必ず** 動的 import

最も効くテクニック。判定の目安: **「ユーザー A は使うが、ユーザー B は使わない機能」**なら動的 import 候補。

```ts
// ❌ Bad: 全プロバイダがメイン chunk に入る
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";

// ✅ Good: 選ばれたプロバイダだけ読み込む
switch (provider) {
  case "openai": {
    const { createOpenAI } = await import("@ai-sdk/openai");
    return createOpenAI(...);
  }
  case "anthropic": {
    const { createAnthropic } = await import("@ai-sdk/anthropic");
    return createAnthropic(...);
  }
}
```

### 5.2 React コンポーネントは `React.lazy` で分離

「初期表示で見えない」UI は遅延ロード。対象:

- ルーティングで切り替わるパネル
- モーダル / ダイアログ
- 設定画面
- ヘルプ / ドキュメント表示

```ts
const SettingsPanel = lazy(() =>
  import("./SettingsPanel").then((m) => ({ default: m.SettingsPanel })),
);
```

### 5.3 重量級ライブラリの遅延ロード判断

| ライブラリ                    | 静的 import で良い場合 | 動的 import 推奨           |
| ----------------------------- | ---------------------- | -------------------------- |
| 状態管理 (zustand 等)         | ほぼ常に静的           | —                          |
| ルーター                      | 静的                   | —                          |
| エディタ (CodeMirror, Monaco) | エディタが主役         | エディタが副次機能         |
| グラフ / チャート             | 専用ダッシュボード     | 「分析タブ」を開いた時のみ |
| Markdown レンダラ             | 常に表示               | ヘルプ等で偶発的に表示     |

判断軸: **初回起動の 5 秒以内にユーザーが触る確率**。低ければ遅延候補。

---

## 6. UI 開発 — shadcn/ui

### 6.1 コンポーネント追加

```bash
bunx shadcn@latest add button
bunx shadcn@latest add dialog
```

`components.json` の `aliases` に従って `src/components/ui/` 配下に追加される。

### 6.2 Tailwind v4 + CSS 変数

スタイルトークンは `src/styles/globals.css` の `:root` / `.dark` で定義した CSS 変数（oklch 色空間）。コンポーネント側は `bg-background text-foreground` のようにユーティリティで使う。

### 6.3 `cn` ヘルパー

クラス結合は必ず `@/lib/utils` の `cn(...)` を経由する（`twMerge(clsx(...))` の合成）。

---

## 7. CI / 数値ゲート（実装初期は緩く、依存が増えたら締める）

推奨閾値:

> No new heavy dependencies (>50KB gzip in client bundle, >5MB compiled on Rust side) without justification

導入手順:

1. `bun --bun vite build` 後の `dist/assets/*.js` を gzip して各 chunk のサイズを CI で記録
2. PR が既存 chunk を +50KB 超 で太らせたら CI red
3. Rust 側は `cargo bloat --release` で監視
4. 例外には justification を PR description に書かせる

現状（依存ゼロ）: `.github/workflows/ci.yml` でサイズを echo するだけ。**重い依存を入れ始めたら閾値ゲートを足す**こと。

### 7.5 Git フック（pre-push で `just check`）

`.githooks/pre-push` が `just check` (= oxlint + oxfmt --check + cargo clippy) を実行する。これを通らないと push できない。仕組み:

- `package.json` の `prepare` script が `bun install` 時に `git config core.hooksPath .githooks` を自動セット
- 既存 clone で hookPath が未設定なら手動で `git config core.hooksPath .githooks` を一度撃つ
- フックを一時的に無効化したいときだけ `git push --no-verify`（ただし CLAUDE.md の方針上、原則使わない）

Husky/lefthook は **入れない**。依存ゼロを保つために `prepare` script + 素の git フックで完結させている。

---

## 8. 計測 — サイズが本当に減ったかを確認する

体感ではなく数値で見る。

### 8.1 Rust バイナリ

```bash
just build                                # release ビルド (.app のみ)
ls -l src-tauri/target/release/monica     # 単体バイナリ
just bloat                                # cargo bloat --release --crates
```

### 8.2 フロントエンドバンドル

```bash
just build                                # frontendDist + .app まで
du -sh dist/
ls -lh dist/assets/ | sort -k5 -h

just analyze                              # dist/stats.html に可視化を出力
```

### 8.3 配布物

現状 monica は配布形態（`.dmg` / `.msi` / `.deb`）を作っていない。`just build` は `--bundles app` を渡しており `.app` までで止まる。配布を始めるときは GitHub Actions の `tauri-action` で各 OS の bundle を CI に作らせる方針。

ローカルで配布形式を確認したいときだけ、手動で `--bundles dmg` 等を渡して `tauri build` を呼ぶ:

```bash
bun run tauri build --bundles dmg         # macOS のみ
ls -lh src-tauri/target/release/bundle/{dmg,msi,deb,rpm,appimage}/
just size                                 # dist/ と bundle/ をまとめて表示
```

**配布を始めた時点で `.dmg` / `.msi` / `.deb` のサイズが最終的な答え**。dev ビルドや `target/release/<bin>` 単体ではなく必ず bundle を見る。

---

## 9. アンチパターン

| やりがち                          | 何が悪いか                           | 代替                                      |
| --------------------------------- | ------------------------------------ | ----------------------------------------- |
| `tokio = { features = ["full"] }` | 使わない macros/fs/net まで入る      | 必要 feature だけ列挙                     |
| `reqwest` をデフォルトで使う      | OpenSSL がリンクされる               | `default-features = false` + `rustls-tls` |
| 全部 `import` で書く              | 起動時に全部パース                   | 条件分岐先は `await import`               |
| `console.log` で大量出力          | 本番にも残る                         | `console.debug` 等にして `pure` で削る    |
| 大きな WebFont を bundle          | 数 MB 増える                         | システムフォント or サブセット化          |
| 「将来使うかも」で依存追加        | 死荷物確定                           | 使う直前に追加                            |
| `oxlint.config.ts` (TS設定)       | Node 22.18+ 要件で CI が落ちる可能性 | `.oxlintrc.json`（JSON）を使う            |

---

## 10. 依存を追加するときの最終チェックリスト

### Rust 依存

- [ ] `default-features = false` を付けたか
- [ ] 必要な feature だけ列挙したか
- [ ] プラットフォーム別 native API の方が小さくならないか検討したか
- [ ] `just bloat` で追加前後のサイズ差を見たか

### フロント依存

- [ ] 50KB gzip を超えそうか？ → 超えるなら `manualChunks` に登録
- [ ] 初回起動で必ず触るか？ → No なら動的 `import()` 化
- [ ] React コンポーネントなら `React.lazy` を検討したか
- [ ] `bun --bun vite build` を走らせて chunk が増えていないか確認したか
- [ ] `just analyze` で stats.html を見たか

### Tauri コマンド

- [ ] 不要になった `#[tauri::command]` は削除したか（`removeUnusedCommands` は自動だがソースに死荷物を残さない）
- [ ] 新規 plugin を入れたら `capabilities/default.json` を更新したか
