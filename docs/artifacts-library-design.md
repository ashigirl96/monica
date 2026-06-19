# Artifact / Library 設計書

作成日: 2026-06-19

## 目的

Monica に、ユーザーが日々入力する文章や写真を蓄積するための Artifact 機能を追加する。

Artifact は、タスク管理やエージェント実行とは別に、ユーザーが保存した一つの意味ある記録単位である。短いメモ、読み返すためのエッセイ、作りたいものの種を同じ保存基盤に載せ、Library から閲覧・編集できるようにする。

v1 の目的は次の通り。

- 日々の軽い記録を `memo` として保存する
- 文章として育てたいものを `essay` として保存する
- 作りたいもの・やりたいことの種を `intent` として保存する
- `memo` / `essay` / `intent` をあとから相互に変換できる
- Library の Timeline で Monica 内の意味ある活動を時系列に見る
- Essay / Intent を一覧から開いて編集できる
- Draft を失わない
- 画像添付を Monica 管理下にコピーして保存する

## 非目的

v1 では次をやらない。

- Artifact から Task への変換
- AI による daily summary / reflection の生成
- 全文検索、FTS、embedding
- Markdown ファイルへの常時ミラー
- 任意ファイル添付
- 別ウィンドウ Writer
- Timeline item の永続化
- Artifact の type 変換履歴保存
- Project の新規作成
- 共有、公開、外部投稿

## 用語

### Artifact

ユーザーが保存した一つの意味ある記録単位。

Artifact は次の性質を持つ。

- 一意な ID を持つ
- 一つの type を持つ
- 本文を持つ
- 作成時刻と更新時刻を持つ
- 必要に応じて出来事の発生時刻を持つ
- 画像添付を持てる

Artifact は Space には属さない。Space は UI 上の作業場所であり、Artifact の意味分類は type が表す。

### Artifact Type

v1 の type は次の 3 種類。

| Type     | 意味                                                |
| -------- | --------------------------------------------------- |
| `memo`   | AI があとで拾うための軽い生ログ。見返す前提は薄い。 |
| `essay`  | 読み返す、文章力を上げる、将来投稿するための文章。  |
| `intent` | 作りたいもの、やりたいこと、実装したいことの種。    |

### Timeline

Timeline は保存テーブルではなく、元データから合成する Activity Timeline である。

表示対象は次の通り。

- Artifact 全種
- Task created
- Task closed

Task run、hook event、terminal session、PR sync の細かいイベントは v1 の Timeline には出さない。

### Draft

正式な Artifact になる前の書きかけ。

Draft は autosave され、アプリ再起動後も復元される。保存操作によって Artifact に昇格する。

## ドメインモデル

Rust を single source of truth とする。フロントでは `just generate-bindings` によって生成された TypeScript 型を使い、同じ enum や判定ロジックを二重定義しない。

### ArtifactKind

`ArtifactKind` は Serde tagged enum として定義する。

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ArtifactKind {
    Memo,
    Essay {
        title: String,
    },
    Intent {
        title: String,
        project_id: Option<String>,
    },
}
```

対応する TypeScript 表現は discriminated union になる。

```ts
type ArtifactKind =
  | { type: "memo" }
  | { type: "essay"; title: string }
  | { type: "intent"; title: string; project_id: string | null };
```

`essay` と `intent` は title 必須。`memo` は title を持たない。

### Artifact

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Artifact {
    pub id: String,
    #[serde(flatten)]
    pub kind: ArtifactKind,
    pub body: String,
    pub created_at: String,
    pub updated_at: String,
    pub occurred_at: Option<String>,
    pub attachments: Vec<Attachment>,
}
```

`body` は Markdown 文字列として保存する。エディタは Notion や しずかなインターネット に近い操作感にしてよいが、保存形式は Markdown とする。

v1 の editor block は Markdown に落とせる範囲に制限する。

- paragraph
- heading
- bold / italic / inline code
- link
- blockquote
- bullet list / ordered list
- code block
- image attachment reference

toggle、callout、columns、database、複雑な embed は v1 では扱わない。

### Attachment

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Attachment {
    pub id: String,
    pub artifact_id: String,
    pub file_name: String,
    pub mime_type: Option<String>,
    pub byte_size: i64,
    pub storage_path: String,
    pub created_at: String,
}
```

v1 の添付は画像のみとする。

対応候補:

- JPEG
- PNG
- WebP
- HEIC

本文 Markdown から添付画像を参照するときは、将来の置換を見越して次のような URI を使う。

```md
![photo](attachment://ATT-123)
```

## DB スキーマ

Artifact は既存の `tasks` / `events` とは別テーブルにする。

`events` は Task / Run に紐づくシステムイベントであり、Artifact はユーザーが明示的に保存した記録である。ライフサイクル、編集可否、検索単位が違うため混ぜない。

概略スキーマ:

```sql
CREATE TABLE artifact_counter (
  n INTEGER PRIMARY KEY AUTOINCREMENT
);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT,
  body_markdown TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id),
  occurred_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE attachment_counter (
  n INTEGER PRIMARY KEY AUTOINCREMENT
);

CREATE TABLE artifact_attachments (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  mime_type TEXT,
  byte_size INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

DB はクエリしやすさを優先し、`kind` / `title` / `project_id` を列として持つ。外向きの Rust 型では `ArtifactKind` に戻し、次の制約を保証する。

- `kind = memo` のとき `title` と `project_id` は使わない
- `kind = essay` のとき `title` は必須
- `kind = intent` のとき `title` は必須、`project_id` は任意

ID は既存 Task の `MON-<n>` と分ける。

| 種別       | ID      |
| ---------- | ------- |
| Task       | `MON-1` |
| Artifact   | `ART-1` |
| Attachment | `ATT-1` |

## Draft

Draft は正式 Artifact とは別に保存する。

Draft 用の保存形式は未完成状態を許す。

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ArtifactDraftKind {
    Memo,
    Essay {
        title: Option<String>,
    },
    Intent {
        title: Option<String>,
        project_id: Option<String>,
    },
}
```

Draft では `essay` / `intent` の title は未入力を許す。正式保存時に validation し、空 title の `essay` / `intent` は Artifact に昇格できない。

Draft は 500ms から 1000ms 程度の debounce で autosave する。タブ切替、Space 切替、アプリ終了前には可能な範囲で flush する。

## Library UI

Artifact は `Library` Space の中に置く。

左端の Space は v1 では次のまま。

- Library
- Work Board
- Work Bench

Library Space 内に sidebar を追加し、次の view を配置する。

- Timeline
- Essay
- Intent

Library の初期 view は Timeline。ただし最後に開いた view は store に保存し、次回起動時に復元する。

```ts
type LibraryView = "timeline" | "essay" | "intent";
```

保存する UI state のイメージ:

```ts
{
  activeSpace: "library",
  library: {
    activeView: "timeline"
  }
}
```

保存値が壊れている場合は `timeline` にフォールバックする。

### Library Sidebar

`alt+j` / `alt+k` で Library view を移動する。

Workbench では既存通り runspace 移動に使い、Library では Library view 移動に使う。activeSpace によって挙動を分ける。

### Library Tabs

Library header は Workbench に近い tab モデルを持つ。

一番左に固定タブを置き、その右に draft / artifact editor tab を開く。

```ts
type LibraryTab =
  | { id: "home"; kind: "home"; view: LibraryView }
  | { id: string; kind: "draft"; draftId: string }
  | { id: string; kind: "artifact"; artifactId: string };
```

固定タブ:

- 一番左に固定
- 閉じられない
- ラベルは現在の Library view 名にする
- sidebar の Timeline / Essay / Intent を選ぶと view が変わり、固定タブに focus する

draft / artifact tab:

- 固定タブの右に開く
- 閉じられる
- `ctrl+tab`、`alt+h`、`alt+l` で移動できる
- 同じ Artifact がすでに開いている場合は新規 tab を作らず focus する

アプリ再起動時:

- Library view は復元する
- draft tab は復元する
- artifact tab は復元しなくてよい

### New Draft

Library active 時の `cmd+n` は、現在の Library view に応じて draft tab を作る。

| 現在 view | 新規 draft type |
| --------- | --------------- |
| Timeline  | `memo`          |
| Essay     | `essay`         |
| Intent    | `intent`        |

Writer 内では type をいつでも切り替えられる。

新規作成用の目立つボタンは置かない。ユーザーは keyboard 操作を知っている前提にする。

### Timeline Inline Composer

Timeline には memo 専用の inline composer も置く。

役割:

- 短い memo を素早く保存する
- 保存後すぐ Timeline に流す

inline composer は memo 専用でよい。長くなった場合や type を切り替えたい場合は Writer tab に展開できるとよい。

## Writer

Writer は `memo` / `essay` / `intent` 共通の編集体験を持つ。

ただし type によって chrome と validation が変わる。

### Memo

- title なし
- project なし
- body と attachments を編集できる
- occurred_at は metadata として編集できる
- 保存済み memo でも type 切替できる

新規 memo draft を保存したら Artifact を作成し、Timeline 固定タブへ戻る。

### Essay

- title 必須
- project なし
- body と attachments を編集できる
- occurred_at は metadata として編集できる

新規 essay draft を保存したら Artifact を作成し、draft tab は artifact tab に変わる。そのまま編集を続けられる。

### Intent

- title 必須
- project は任意
- body と attachments を編集できる
- occurred_at は metadata として編集できる
- `ctrl+w` で project picker modal を開く

Project picker は既存 Project だけを対象にする。新規 Project 作成は v1 では行わない。

### Autosave

新規 draft:

- 編集内容は draft として autosave
- 正式 Artifact 化には明示的な Save が必要

保存済み Artifact:

- 本文、title、project、occurred_at、type 変更は autosave
- `essay` / `intent` で title が空になる場合は保存できない状態として扱う
- title が入力され validation を満たした時点で autosave する

Type 変換:

- 保存済み Artifact でも type を変更できる
- 変換履歴は保存しない
- 変換先で使わないフィールドは捨てる
- 同じ Artifact ID のまま kind を更新する

例:

- `memo` から `essay` に変換したら title 入力欄が出る
- title が空の間は未保存状態
- title 入力後に autosave される
- Timeline 上では同じ item の表示形式が変わる

## Timeline

Timeline は `artifacts` と `tasks` から合成する view である。Timeline item 自体は保存しない。

### 表示対象

Artifact:

- `memo`
- `essay`
- `intent`

Task:

- `tasks.created_at`
- `tasks.closed_at`

Task run、hook event、PR sync、terminal session は v1 では表示しない。

### TimelineItem

概念上の型:

```ts
type TimelineItem =
  | {
      kind: "artifact";
      artifact_id: string;
      timeline_at: string;
    }
  | {
      kind: "task_created";
      task_id: string;
      timeline_at: string;
    }
  | {
      kind: "task_closed";
      task_id: string;
      timeline_at: string;
    };
```

Artifact の `timeline_at` は次で決める。

```ts
timeline_at = artifact.occurred_at ?? artifact.created_at;
```

Task created は `tasks.created_at`、Task closed は `tasks.closed_at` を使う。

Artifact の type を変えても `created_at` / `occurred_at` は変えない。そのため Timeline 上の位置も変わらない。

### 並びとページング

- 最新順
- 日付見出しなし
- Twitter のようなシームレスな stream
- 初期ロードは直近 7 日以内の最新 30 件まで
- 30 件未満でも 7 日より前の item で埋めない
- 下までスクロールしたら、さらに古い 30 件を自動取得する

カーソルは `timeline_at` と tie-breaker ID を組み合わせる。

```ts
listTimelineItems({
  before?: {
    timeline_at: string;
    id: string;
  },
  since?: string,
  limit: 30,
})
```

初回は `since = now - 7 days` を指定する。以降の infinite scroll では `before` を使って古い item を取得する。

### 表示ルール

`memo`:

- 本文全文を表示
- 画像添付をサムネイル表示
- 折りたたまない

`essay`:

- title
- body preview 1 から 2 行
- updated_at などの小さい metadata

`intent`:

- title
- project label
- body preview 1 から 2 行

Task:

- compact system row
- 例: `MON-123 created`
- 例: `MON-123 closed`

Timeline item をクリックすると Library の artifact tab を開く。すでに開いている場合はその tab に focus する。

Memo をクリックして開いた editor tab でも type 変更できる。

## Essay View

Essay view は、読み返すための静かな一覧にする。

表示:

- title
- body preview
- updated_at

操作:

- `cmd+n` で essay draft tab を作成
- item click で artifact tab を開く
- 既に開いている場合は focus

目立つ New ボタンや説明テキストは置かない。

## Intent View

Intent view は Project ごとに group して表示する。

表示:

```txt
Project A
  Intent title
  Intent title

Unassigned
  Intent title
```

本文 preview は控えめでよい。Intent は文章を読むより、作りたいものの種を project 文脈で scan できることを優先する。

操作:

- `cmd+n` で intent draft tab を作成
- item click で artifact tab を開く
- Intent editor 内の `ctrl+w` で project picker modal を開く
- Project picker は fuzzy search
- `Enter` で選択
- `Esc` で閉じる
- clear 操作で unassigned に戻せる

## 添付ファイル

画像添付は Monica 管理下にコピーする。

保存場所:

```txt
~/Monica/attachments/{artifact_id}/{attachment_id}-{file_name}
```

例:

```txt
~/Monica/attachments/ART-123/ATT-456-photo.jpg
```

Application Support ではなく `~/Monica/attachments/` にする。ユーザーがファイルを見つけやすく、長期利用でも安心できるため。

Artifact から添付を削除したら、確認した上で実体ファイルも削除する。

## Commands / Usecases

Rust 側に domain / repository / usecase を追加し、Tauri command から呼ぶ。

想定 usecase:

- create draft
- update draft
- delete draft
- list drafts
- create artifact from draft
- get artifact
- update artifact
- delete artifact
- list essays
- list intents grouped by project
- list timeline items
- attach image to draft or artifact
- remove attachment

Tauri command を追加したら `just generate-bindings` を実行し、`src/commands/bindings.ts` は手動編集しない。

## 実装順

1. Rust domain 型を追加する
2. SQLite migration と repository を追加する
3. Artifact / Draft / Timeline usecase を追加する
4. Tauri commands を追加する
5. `just generate-bindings` で TS bindings を更新する
6. Frontend の Library store を追加する
7. Library sidebar と fixed tab model を作る
8. Draft / Artifact Writer tab を作る
9. Timeline query と infinite scroll を作る
10. Essay view / Intent view を作る
11. 画像添付の copy / render / delete を作る
12. autosave と draft restore を仕上げる

## 検証観点

- `memo` / `essay` / `intent` が Rust 型から TS 型へ正しく生成される
- `essay` / `intent` は title なしで正式保存できない
- `memo` は title を持たない
- `intent` は project なしでも保存できる
- 保存済み Artifact の type を変更できる
- type 変更しても Artifact ID は変わらない
- 変換先で不要な field は保存されない
- Draft は再起動後に復元される
- 保存済み Artifact は autosave される
- Timeline は直近 7 日以内の最新 30 件から始まる
- Timeline の infinite scroll が重複なく古い item を取る
- `occurred_at` を設定した Artifact はその時刻で Timeline に並ぶ
- Task created / closed だけが Timeline に出る
- 画像添付は `~/Monica/attachments/` にコピーされる
- 添付削除時に DB と実体ファイルが揃って消える
- `cmd+n` が Library view に応じた draft を作る
- `alt+j/k` が Library view を移動する
- Intent editor 内だけ `ctrl+w` で project picker が開く
