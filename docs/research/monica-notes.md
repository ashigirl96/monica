# monica の notes

wayfinder の map「monica の notes を tania に移す」の charting で調べた事実。monica は `/Users/1e0nhard96/.ghq/src/github.com/ashigirl96/monica`（以下のパスはここからの相対）、実データは 2026-10-05 19:29 UTC にコピーした `~/monica/db/monica.db` と `~/monica/assets` と `~/monica/settings.json` を読んだ。notes 以外の機能（Task・terminal・agent・translate・explanations）は読んでいない。

## 要点

| 問い | 答え |
|---|---|
| 量 | notes は 159 行（生存 138、soft delete 21）。生存は daily 68・essay 22・project 48。本文は合計約 1.2MB、最大 86KB |
| 使われ方 | 2026-07-17 に始まり、直近 30 日で作成 47・更新 53。3 種とも現役（30 日の作成は daily 25・project 17・essay 3） |
| 本文の形 | ProseMirror の doc JSON を TEXT 列にそのまま保存。`doc → blockGroup → blockContainer(attrs.id) → [blockContent, blockGroup?]` |
| project との紐づけ | `kind=project` の note だけが `project_id`（`owner/repo`）を持つ。daily と essay は全件 NULL。project ごとに primary note が 1 つ |
| 画像 | `~/monica/assets/<uuid>.png` が 15 枚（10.6MB）。本文の image node の `src: /api/assets/<uuid>.png` と 1 対 1 で、欠けも余りも無い |
| note 間の参照 | noteMention 12、syncedBlock 1、`http://monica.localhost:19280/...` への link mark 9、相対の `/notes/note-3` 1 |
| エディタ | `shared/block-editor` は ProseMirror 上の自作（`@milkdown/kit/prose/*` を re-export として使うだけ）。monica の API は props で注入する |
| ブラウザへの配り方 | monica desktop の process の中の thread が `127.0.0.1:19280` 固定で配る。token は無く、Host ヘッダの照合で DNS rebinding を防ぐ。Tailscale の IP にも追加で bind する |
| 設定 | `settings.json` の notes 節は `day_boundary_hour: 5` だけ |

## データ

### schema

```sql
CREATE TABLE notes (
  id         TEXT PRIMARY KEY,
  title      TEXT,
  kind       TEXT NOT NULL DEFAULT 'memo',
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  content    TEXT NOT NULL DEFAULT '{"type":"doc","content":[{"type":"blockGroup","content":[{"type":"blockContainer","content":[{"type":"paragraph"}]}]}]}',
  date       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d','now','localtime')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at TEXT,
  status     TEXT
);
CREATE INDEX notes_date_idx ON notes(date);
CREATE INDEX notes_project_idx ON notes(project_id, date);
CREATE TABLE note_counter (n INTEGER PRIMARY KEY AUTOINCREMENT);
CREATE VIRTUAL TABLE notes_fts USING fts5(body, note_id UNINDEXED, tokenize = 'trigram');
```

projects 表は `id, name, provider, repo, path, default_branch, worktree_root, setup_timeout_sec, agent_default, agent_permission_mode, hooks_claude, created_at, updated_at, primary_note_id` を持つ。notes が使うのは `id` と `primary_note_id` だけ。

### 行の内訳

| kind | 総数 | 削除済み | 生存 | title | status |
|---|---|---|---|---|---|
| daily | 72 | 4 | 68 | 全件なし | 全件 NULL |
| essay | 26 | 4 | 22 | 全件あり | finished 11・writing 12・NULL 3（うち生存 2） |
| project | 61 | 13 | 48 | 13 件なし（8 件は削除済み） | 全件 NULL |

- id は `note-N`（note-1〜note-160、note-100 だけ欠番）。番号は `note_counter` の rowid で、削除しても再利用しない。
- `date` は作成時に固定した Logical Date で、JST の 5 時を境目にした日付とほぼ一致する（daily の 6 件だけ、カレンダーから別の日を開いて作ったもの）。生存する daily で同じ日付が 2 件あるのは 2026-07-20 の 1 組だけで、get-or-create が最古を返すので、遅く作った note-13 は画面から開けない（daily を作るたびに新しい note を作っていた 2026-07-24 より前の名残）。
- 既定の空本文のまま残った note は 10 件（daily 9、project 1）。

### project ごとの note

| project（`owner/repo`） | 総数 | 生存 | primary note |
|---|---|---|---|
| ashigirl96/monica | 18 | 10 | note-25 |
| work-org-2/repo-a | 18 | 16 | note-46 |
| work-org/repo-b | 16 | 13 | note-52 |
| ashigirl96/me | 6 | 6 | note-27 |
| ashigirl96/tania | 3 | 3 | note-153 |
| ashigirl96/kamishibai、work-org/repo-c、work-org/repo-d | 0 | 0 | なし |

primary note はすべて、その project に属する生きた project note を指す。存在しない project を指す note は無い。

### 本文

node の type の出現回数（括弧は含む note 数）: paragraph 1512 (135)、bullet 1273 (104)、tableCell 930 (15)、heading 376 (88)、numbered 146 (22)、todo 110 (25)、codeBlock 86 (19)、divider 83 (38)、callout 75 (24)、hardBreak 68 (21)、table 59 (15)、linkMention 42 (27)、bookmark 20 (13)、quote 19 (8)、image 15 (10)、noteMention 12 (9)、toggle 6 (2)、syncedBlock 1 (1)。mark は bold 669、code 473、link 50、underline 7、strike 2。

- block の id は `blockContainer.attrs.id` の UUID（3770 個、すべて一意）。入れ子は最大で `.content[` の深さ 10。
- 保存された本文のキーはアルファベット順に並ぶ（空のまま残った 10 件だけが既定値の並び）。
- daily は todo と bullet、project は bullet・heading・table、essay は paragraph が中心。

### 参照

- noteMention: 参照元は daily 9・essay 3、参照先は essay 7 種・project 1 種。すべて存在し、削除済みは無い。
- syncedBlock: note-28（project、ashigirl96/me）から note-30（daily）の blockIds 10 個。すべて存在する。
- アプリ内 URL の link mark: `http://monica.localhost:19280/projects/<owner>/<repo>/notes/note-N` が 3、`/essays/note-N` が 1、`/explanations/expl-N` が 5（explanations は notes 以外の機能）、相対の `/notes/note-3` が 1。
- text に書かれた `#数字` 26 個は GitHub の issue と PR の番号で、Task への参照は無い。
- 外部の画像 URL（bookmark の thumbnail、favicon）は assets に置かれていない。

## ドメインモデル（サーバー）

- `NoteKind`（`crates/monica-domain/src/note.rs:52-70`）は `project { project_id, title }`・`daily`・`essay { title, status }`。コメントは kind を「note の『取り出し方』による分類」と定義する（:48-51）。essay の status は `writing` / `finished` で、NULL は writing と読む（status の列を後から足したときに backfill していない）。kind を変える遷移は無い。kind を変える API は 2026-07-18〜07-25 にだけあり、その後も essay から project note へ本文を写して元を消した跡が 2 組ある。
- title は専用の列。daily は title を持たず、essay と project が同じ列を使う。表示名は essay なら title（空なら `Untitled`）、daily なら date、project なら title（空なら project_id）。
- daily は日付ごとに get-or-create する（`PUT /api/notes/daily/{date}`）。同じ日に複数あれば最古を返す。
- 作成と更新は UTC の ISO 文字列。`updated_at` を進めるのは本文の更新と essay の status だけで、削除と復元は進めない。
- 削除は soft delete（`deleted_at`）で、物理削除するコードは無い。復元を呼ぶのは project と essay の画面の ⌥Z（画面のメモリにある stack で、reload で消える）と primary note の get-or-create だけで、削除済みを一覧する画面も API も無い。daily と primary note は画面から削除できない（primary を断るのは画面だけで、サーバーは拒まない）。削除済み 21 件のうち 6 件は作成から 1 日以上経ってから消されている。
- 並び順の列は無い。daily と project は `date DESC, rowid DESC`、essay は `created_at DESC`、検索は `updated_at DESC`。
- 全文検索は fts5 の trigram で、本文の plain text を同じ transaction で書く（DELETE してから INSERT、rowid は `note-N` の N）。soft delete と restore は fts の行に触れず、検索が `deleted_at IS NULL` で外す。3 codepoint 未満は `body LIKE`。どちらも title・project_id・date の LIKE と OR でつなぎ、`updated_at DESC` で並べる。snippet は返さない（`crates/monica-storage-sqlite/src/store/notes.rs:79-97, 350-393`）。
- **全文検索を呼ぶのは CLI の `monica note search`（50 件）だけで、HTTP の route は無い。** web の `[[` の候補検索（`GET /api/notes/mentions?q=`）は同じ検索を粗い絞り込みに使い（q が空なら 20 件、あれば 200 件）、facade が表示名か preview の部分一致で 20 件に絞る。本文の 2 行目以降だけに当たる note は候補に出ない（`crates/monica-application/src/facade/notes.rs:110-123`、テスト `crates/monica-web/src/lib.rs:1864`）。
- plain text（`crates/monica-domain/src/note_doc.rs:396-416, 477-534`）は blockContainer ごとに 1 行で、text・codeBlock・表のセル・linkMention と bookmark の title（無ければ href）を含み、noteMention は表示名ではなく note id を入れる。syncedBlock・image・mark は含めない。preview は最初の空でない block の text を 200 文字までにしたもので、plain text の部分文字列になるように揃えてある。一覧（essays・by-project・mentions）は content を返さず preview を返すが、store は行ごとに content 全体を SELECT して parse している（`store/notes.rs:67-77`）。
- markdown は保存形式ではなく派生物。`note_markdown.rs`（doc → markdown、532 行、noteMention は `[[note-7|表示名]]`、syncedBlock は `![[note-7#^blk]]`）と `note_markdown_import.rs`（markdown → doc、819 行、block id は振らない）。どちらも外部 crate を使わない自作で失敗しない。toggle は import すると quote になり、bookmark と linkMention は link mark になる（往復しない）。テストは `crates/monica-domain/tests/` に 47 本あり、fixture（全 node 型の `full-doc.json`、未知の node・inline・mark を 1 つずつ持つ `unknown-nodes.json`）と golden の markdown は JSON と文字列なので他の言語のテストに移せる。
- synced block の展開は深さ 8 まで、循環は (note, block) の visited で打ち切る。これを使うのは CLI の `--expand` と、web が呼ばない `GET /api/notes/{id}?format=markdown&expand=synced` だけ。web の synced block は `GET /api/notes/{id}/blocks/{block_id}` で 1 段だけ取り、入れ子は「Nested synced block」の placeholder にする（`shared/block-editor/synced-block.ts:30-31, 76`）。
- 不変条件はほとんど store の SQL にある。daily の get-or-create（`Immediate` の transaction で最古を返す、`store/notes.rs:189-214`）、primary note の get-or-create と復元（`:225-290`）、楽観ロック（`AND (?4 IS NULL OR updated_at = ?4)`、0 行なら同じ transaction で Stale と Missing を見分ける、`:413-458`）、`updated_at` を進める `SET_NOW`、id の採番（`note_counter`）。primary note の title の固定と削除の禁止は web にしか無い。
- 表示名の規則が 2 か所にある。domain の `display_name`（`crates/monica-domain/src/note.rs:110-118`、mention と markdown が使う）と、web の一覧の見出しの `web/src/notes/summary.ts:5-19`（title、無ければ preview、無ければ `Untitled`）。title の無い project note は前者で project_id、後者で preview か `Untitled` になる。

## project との紐づけ

- `notes.project_id → projects.id`（`ON DELETE SET NULL`）と、逆向きの `projects.primary_note_id → notes.id`。
- project を消して `project_id` が NULL になった `kind=project` の行は daily として読まれる。
- project の id は `owner/repo` で、notes が project から使うのはこの id だけ（保存、表示名の代わり、検索の LIKE）。name・path・repo は使わない。
- primary note は `/projects/<owner>/<repo>` を初めて開いたときに get-or-create する。title は編集できず（DB には空文字 `''` が入る）、削除もできない。soft delete されていれば作り直さず復元する。
- primary note 5 件は、5 件とも作成から 1 日以上更新が続き（2 件は 30 日以上）、アイデアや TODO を追記する置き場として使われている。title のある project note 43 件は話題ごとの文書で、24 件は作成から 1 日未満で最後の更新になる。
- projects 表の 8 行は、`id` と `repo` が同じ `owner/repo`、`provider` が `github`、`path` が ghq のレイアウトと一致する。8 つとも GitHub に実在し、ghq の checkout もある。

## 画像（asset）

- 保存先は `$MONICA_HOME/assets/<id>`（既定は `~/monica/assets`）のフラットな構成。id は `<uuid v4>.<ext>` で、ext は `png | jpg | gif | webp`。形式は magic bytes で判定し、SVG は受け付けない。上限は 20MB（`crates/monica-adapters/src/assets/mod.rs`）。
- `POST /api/assets`（生のバイト列 → `{ id, url }`）、`POST /api/assets/import`（外部 URL を取ってきて保存。10 秒で打ち切る）、`GET /api/assets/{id}`（`cache-control: immutable`）。
- note と asset の対応表は無い。GC は desktop の起動 10 分後と以後 24 時間ごとに走り、全 note（削除済みを含む）の本文に `/api/assets/` で始まる文字列として現れず、mtime から 48 時間以上経ったファイルを消す（`crates/monica-runtime/src/asset_gc.rs`、`crates/monica-adapters/src/assets/gc.rs`）。
- エディタは貼り付けとドロップで `src: null, uploadId` の node を先に入れ、upload が済むと src を差し替える（undo の履歴に入れない）。外部 HTML の `<img>` は `/api/assets/import` でローカルに取り込み、失敗すれば外部 URL のまま残す。
- upload は Content-Type を見ず、バイト列を再 encode せずに書く。magic bytes が合わなければ 415、20MB を超えれば 413、成功は 201。import は http/https だけを受け、chunk ごとに数えて 20MB で 413、取得の失敗は 502。status は見ないが、HTML のエラー頁は magic bytes で 415 になる。どちらも行き先の host や IP は制限しない（`crates/monica-adapters/src/assets/mod.rs:92-201`）。
- GET は id を小文字の UUID と 4 つの拡張子で厳密に照合し、合わなければファイルが無いときと同じ 404。ETag は付けず、ファイル全体をメモリに読む（`crates/monica-web/src/lib.rs:696-715`）。
- GC は note の JSON を node の型を問わずに走査し、`/api/assets/` で始まる文字列値だけを参照として数える。`http://monica.localhost:19280/api/assets/...` のような絶対 URL は数えない。asset id の形をしたファイル名だけを消し、mtime が読めないものと未来のものは残す（`crates/monica-adapters/src/assets/gc.rs:15-91`）。

## OGP（linkMention と bookmark）

- `crates/monica-adapters/src/ogp/mod.rs`（本体 149 行）。reqwest と scraper で、timeout は 10 秒、HTML は 1MB で切り詰めてそのまま parse する。content-type が無いか `html` を含むときだけ本文を読む。
- response の status を見ないので、404 の頁でもその HTML から値を取る。redirect は reqwest の既定（10 回）で追い、相対 URL の基準は最後の URL。User-Agent は送らない。cache は server にも client にも無い。行き先の制限は scheme（http/https）だけ。
- 取る項目は title（`og:title`、無ければ `<title>`）、description（`og:description`、無ければ `meta name=description`）、image（`og:image` を絶対 URL に）、site_name、favicon（`rel` に icon を含む最初の `link`、無ければ `/favicon.ico`）。
- 取った値は貼り付けた時点で本文の attrs に入る。linkMention は `{href, title, favicon}`、bookmark は `{href, title, description, thumbnail, favicon, siteName}`。href は貼った URL のままで、画像は外部 URL を直に参照する（`shared/block-editor/link-menu.ts:80-96, 240-250`）。失敗すると web は普通のリンクに戻す。

## エディタ（`shared/block-editor`）

- ProseMirror を直接組む（`new Schema`・`EditorState.create`・`new EditorView`）。依存は root の `@milkdown/kit ^7.22.1` だけで、Milkdown の Editor や preset は使わない。表は自前で、prosemirror-tables は使わない。コードの構文ハイライトは無い。
- 11,678 行（本体の TS と TSX 6,995、`block-editor.css` 1,241、テストと fixture 3,442）。package.json も barrel も無く、web は alias `@shared/*` で import する。web が値として import するのは `BlockEditor` と `stripPendingImages` の 2 つで、残りは型。props は mount 時に固定され、差し替えは `key` を変えた再 mount で行う（`web/src/notes/note-block-editor.tsx:39`）。
- 使う subpath は `@milkdown/kit/prose/` の state・model・view・keymap・inputrules・history・commands の 7 つ。どれも `@milkdown/prose` を経て `prosemirror-*` を `export *` するだけ。入っている版は prosemirror-state 1.4.4、model 1.25.11、view 1.42.3、keymap 1.2.3、inputrules 1.5.1、history 1.5.0、commands 1.7.2（推移的に transform 1.12.1）。
- テストは `bun test` で、DOM の環境は無い。EditorState だけで回し、EditorView は型キャストした最小のモックで代える。block-editor に 11 本（最大は commands の 1,189 行）、`web/src/notes` に 3 本（note-ledger・note-sync・summary）、ほかに `pages/essays/support.test.ts`。hook と component のテストは無い。
- ブロック: paragraph、heading（1〜3、collapsed）、todo、bullet、numbered（decimal / lower-alpha / lower-roman）、toggle、quote、callout（note / tips / danger / question / example）、codeBlock（language、wrap）、table、divider、bookmark、syncedBlock、image。inline: text、linkMention、noteMention、hardBreak。mark: bold、italic、underline、strike、code、link。
- NodeView は React ではなく `document.createElement` で組む。
- import しているのは web だけ（desktop の journal space は削除済み）。外への import は `react` と `@milkdown/kit/prose/*` だけ。
- monica 固有の口は props で注入する: `fetchLinkMetadata`、`searchNoteMentions`、`resolveNoteMention`、`onNoteMentionClick`、`resolveBlock`、`onOpenBlock`、`uploadImage`、`importExternalImage`、`renderMarkdown`、`parseMarkdown`。渡さなければその機能が無効になる。
- 直書きされているもの: `noteHref = /notes/${id}`（`schema.ts:9-11`）と、`window.location.origin` で自分の note の URL かを見る `internalNoteId`（`note-mention-menu.ts:47-62, 94, 218, 287`）、`ASSET_URL_PREFIX = "/api/assets/"`（`schema.ts:21`、Rust 側と文字列を合わせている）、clipboard の MIME `application/x-monica-blocks+json`（`clipboard.ts:18`）、dev でだけ IME の debug plugin を入れる `import.meta.env.DEV`（`create-editor.ts:123`）、ホストの CSS 変数と Tailwind の `relative`。
- CSS は `shared/block-editor/block-editor.css`（1241 行、`.jb-*`）と `web/src/notes/notes.css`（122 行、`--ink`・`--paper`・`--desk`）。block-editor.css がホストから読むのは `--foreground`・`--background`・`--popover`・`--popover-foreground`（後ろ 2 つは fallback 付き）で、祖先の `[data-density="compact"]` で詰める。menu は `relative` を付けた host（`view.dom.parentElement`）に append するので、`relative` は機能に要る。
- 操作: `/` か Cmd-J のスラッシュメニュー（callout 5 種と Table）、ほかは markdown 風の input rule。`[[` で note のリンク、URL の貼り付けで「Paste as」（URL / Mention / Bookmark、OGP は `GET /api/ogp`）、ブロックの貼り付けで「Paste / Paste and sync」。copy は選択範囲を `POST /api/notes/markdown` で markdown にし、text/plain だけの paste は `POST /api/notes/from-markdown` で doc にする。ブロック選択（Esc / Cmd-A）と移動・複製・削除。

## 本文の中の参照

チケット「本文の中の参照の語」でコードを読んで確かめた（動かしてはいない）。パスは `shared/block-editor/` からの相対で、`web/` と `crates/` で始まるものは repo の root から。

| node / mark | 画面の語 | 形 | 指すもの | 参照先が無いとき |
|---|---|---|---|---|
| noteMention | `[[` のメニューの見出しが「Link to note」 | inline の atom の chip | Note 1 つ（attrs は `noteId` だけ） | 「Deleted note」（打ち消し線） |
| syncedBlock | ラベルが「Synced」、作るのは「Paste and sync」 | block の atom、読み取り専用 | 1 つの Note の block の並び（`noteId` と `blockIds[]`） | 「Original block was deleted」 |
| linkMention | 「Paste as」の「Mention」 | inline の atom の chip（favicon と title） | 外部の URL | 確かめない |
| bookmark | 「Paste as」の「Bookmark」 | block の atom のカード | 外部の URL | 確かめない |
| link mark | 「Paste as」の「URL」（既定） | 文字に付く mark | URL | 確かめない |

- 4 つの node をまとめて呼ぶ語はコードに無い。コメントは noteMention を「ノート間リンク（wiki link）」、syncedBlock を「transclusion」、linkMention と bookmark を URL の「インラインチップ表現」と「カード表現」と呼ぶ（`schema.ts:248, 291, 364, 397`）。noteMention と linkMention は `.jb-mention` の見た目を共有する（`block-editor.css:826-857`）。
- noteMention の表示名は attrs に持たず、表示のたびに引く（改題に追従させるため、`schema.ts:397-398`）。引いた結果は開いている note ごとに cache し、note を開き直すまで更新しない（`web/src/notes/editor-support.ts:116-130`）。
- 削除済みの note は `[[` の候補に出ず、mention の解決も 404 を返す（`crates/monica-storage-sqlite/src/store/notes.rs:292-301, 350-366`）。web の `resolveNoteMention` は通信エラーでも null を返すので、server に繋がらないときも「Deleted note」と出る（`web/src/api.ts:200-210`）。今開いている note も候補から外さない。
- syncedBlock の中は todo や toggle も操作できない（`synced-block.ts:32, 130-131`）。「↗」（Go to original block）は先頭の block へ飛び、別の note なら `/notes/{id}` へ移ってからスクロールする（`synced-block.ts:143-148`、`web/src/notes/block-jump.ts`）。同じ note の block の編集はすぐ映し、別の note の block は NodeView を作ったときに 1 回だけ取る。一部の block だけ無ければ、残りを黙って出す（`synced-block.ts:176-208`）。
- syncedBlock ができるのは、block を選んで copy してから「Paste and sync」を選んだときと、markdown の `![[note]]`・`![[note#^blk]]` を貼ったときだけ。cut したときと文字を選んで copy したときは「Paste and sync」が出ない（`clipboard.ts:548-603`）。
- linkMention と bookmark の OGP の値は貼った時点のまま持ち続け、click は新しいタブで開く（`node-views.ts:358-370`）。bookmark の `siteName` は保存するが表示しない。markdown に書き出すとどちらも `[title](href)` になり、読み込むと link mark に落ちる。
- 自分の note の URL が noteMention になるのは、何も選んでいないときの paste と、`[[` の query に URL を入れたときだけ。拾うのは自分の origin の `/notes/<id>` の形の絶対 URL だけ（`note-mention-menu.ts:44-60, 273-293`）。後から link mark や linkMention を noteMention に変える処理は無く、link mark は自分の note の URL でも新しいタブで開く（`link-click.ts:16-27`）。
- block の id を参照として持つのは syncedBlock だけ。URL の hash で block を指す仕組みは無く、`#^` は markdown にしか出ない。backlink（逆引き）の一覧も API も無い。

## 保存と競合

- エディタは doc が変わったときだけ immutable な node を渡し、ページが 1 秒の debounce で `PUT /api/notes/{id}` に全文を送る（`web/src/notes/use-autosave.ts`）。送信は直列にし、失敗は 5 秒後に再試行する。pagehide では `keepalive` で flush する。
- 送る `title` は、essay と primary でない project note では文字列、daily と primary では `null`（触らない）（`web/src/pages/daily/index.tsx`、`web/src/pages/projects/editor.tsx` の `scheduleSave`）。
- 409 以外の失敗（接続できない、404、500）はどれも同じ経路で、成功するまで 5 秒おきに再試行し続ける。上限も間隔の伸長も無い。ヘッダには「Failed to save — changes retry on next edit」を出す（`web/src/notes/use-autosave.ts:114-129`、`save-status.tsx:22-28`）。接続が切れたことを示す表示は無い。
- 未保存の編集はメモリにしか無い。localStorage や IndexedDB に退避せず、`beforeunload` の確認も無い。server が居ない間にタブを閉じると、pagehide の flush が失敗して編集が失われる。
- SSE や WebSocket は無い。
- 楽観ロック: `expected_updated_at` が違えば 409。開いている note ならヘッダに「別の場所でこのノートが更新されました」と「最新を読み込む」（ローカルの編集を捨てる）を出し、開いていない note は左下に常駐の通知を出す。マージはしない。
- 外の更新は focus のたびに取り直し、未保存が無いときだけ採用してエディタを再 mount する。
- `use-autosave.ts` と `note-sync.ts` は TanStack Query を import しない。debounce の timer はアプリ全体で 1 つで、1 回の flush の中では複数の note を並列に送る。PUT の応答は doc を返さないので query の cache は 1 世代古くなり、それを `usableServerDoc` が弾く。
- 削除と essay の status の切り替えは、先に flush して未保存が残れば中止する。

## 画面と routing

- router は自作（`web/src/app.tsx`）。`/notes[/:id]`（旧 URL のリダイレクト。noteMention の href が `/notes/{id}` で保存されているので残す）、`/daily[/:date]`、`/essays[/:id]`、`/projects[/:owner/:repo[/notes/:noteId]]`、`/settings`。
- daily: `/daily` は論理上の今日に置き換わる。開くことが作成。サイドバーは「note のある日と今日」の降順と月のカレンダー。
- essays: カードの一覧（右クリックで status 切り替えと削除）と編集画面（title、writing / finished、サイドバーは 2 タブ）。
- projects: 前回の project を localStorage から開き、無ければ fuzzy picker。primary を上に固定し、その下に時系列を無限スクロールで並べる。
- 共通の枠はサイドバーの幅（260〜720px）と表示密度を localStorage に持つ。本文の幅は 760px。
- ページのキー: ⌥J / ⌥K でサイドバーを巡回、⌥N で作成、⌥Backspace で削除、⌥Z で取り消し、⌥H / ⌥L で essay のタブ、⌃W で status か project の切り替え、⌥D で密度、⌥B で zen、⌃1 / ⌃2 / ⌃3 で daily / essays / projects。
- router は `web/src/app.tsx`（101 行）の自作。`useSyncExternalStore` で `popstate` を購読し、`navigate` は pushState の後に合成の `PopStateEvent` を投げる。Link の component は無く、`<a onClick>` 用の `spaLinkClick` がある。
- query key は 8 種（`web/src/query.ts:3-12`）。`refetchOnWindowFocus: true` で、`focusManager` を自前の focus・blur・visibilitychange の監視に替えている。project の note の一覧は offset の `useInfiniteQuery`。`useMutation` は無く、作成・削除・status・復元は fetch を直に呼んでから cache を書き換えるか invalidate する。fetch は `web/src/api.ts` に関数ごとの素の `fetch` で、型は specta が Rust から生成した `types.gen.ts`。
- notes の画面が notes と pages の外から import するのは `api`・`query`・`app`（navigate）・`keys`・`types.gen`・`components/fuzzy-picker-modal`（`shared/fuzzy-picker` を使う）・`components/context-menu`。toast や popover の library は無い。
- テーマは system / light / dark（`web/src/theme.ts`、`index.html` の描画前の script）。notes の面は既定が dark（hue 264）で、light を `:root[data-theme="light"]` で上書きする。ambient は面の下に敷く背景写真で、none・universe（既定）・sakura・village・fireworks・shrine の 6 種（`web/src/ambient.ts`、JPG で 1.7MB、写真ごとに blur と opacity を持つ）。どちらも app-shell の switcher で切り替える。
- キーは library を使わず、画面ごとに `window` の capture phase の `keydown` で取り、`e.code` で判定する。
- React 19.2.8、TanStack Query 5.102.8（staleTime 0、retry なし）、素の fetch、Tailwind 4.3.3、Vite 8.2.2。jotai・clsx・tailwind-merge・date-fns・lucide-react は notes では使っていない（日付は自作の `notes/dates.ts`、icon は inline の SVG）。

### route の細部

- `/notes` は `/daily` に、`/notes/:id` は `GET /api/notes/{id}` の kind で `/essays/{id}`・`/projects/{project_id}/notes/{id}`・`/daily/{date}` に replace する。削除済みは 404 で「Note not found」（`web/src/pages/note-redirect.tsx:14-38`）。`project_id` が NULL になった project note は daily として読まれるので、その日の別の daily が開く。
- `/projects/:owner/:repo/notes/<primary の id>` は、読み込み後に `/projects/:owner/:repo` へ replace する（`web/src/pages/projects/editor.tsx:105-110`）。primary の正の path は `/projects/:owner/:repo`。
- `/` は server が `/explanations` にリダイレクトする（`crates/monica-web/src/lib.rs:210-212`）。client の未知の path は explanations の一覧になる（`web/src/app.tsx:64`）。
- noteMention の素のクリックは flush してから `/notes/{id}` へ push し、⌘ / ⌃ 付きは `window.open` で新しいタブに開く（`shared/block-editor/node-views.ts:427-432`）。synced block へのジャンプと競合の通知の「開く」も `/notes/{id}` を使う。
- link mark のクリックは origin を見ずに `window.open(href, '_blank', 'noopener')` で開くので、保存された `http://monica.localhost:19280/...` も SPA の中では遷移しない（`shared/block-editor/link-click.ts:16-27`）。URL の paste を mention に変えるのは、同じ origin の `/notes/<id>` だけ（`note-mention-menu.ts:47-60`）。

### 画面の細部

- rail は幅 48px の縦の列で、上から favicon、Daily / Essay / Project / Library / Settings のアイコン（tooltip に ⌃1 など）、一番下にテーマの切り替え（押すたびに system → light → dark）（`web/src/components/app-shell.tsx:149-224`）。
- NotesShell（daily・essay の編集・project の編集）のサイドバーは既定 400px で、境界のドラッグで 260〜720px、ダブルクリックで 400px に戻る。3 画面で同じ幅を共有する（`web/src/notes/notes-shell.tsx:13-58, 137-146`）。
- 密度は relaxed と compact の 2 段で、compact は縦のリズムだけを詰める（`--jb-line` 32→28px など）。zen は rail とサイドバーを幅 0 にし、右下の ambient と本文の幅のピルは残す。zen は保存しない（`app-shell.tsx:126-135`）。
- 本文の幅は 760px に、右下のスライダーで 0〜520px を 8px 刻みで足せる（`web/src/note-width.ts`）。
- daily のサイドバーの行は日付だけ（件数も要約も出さない）。カレンダーは日曜始まりで、月の label のクリックで今日に戻り、未来を含むどの日もクリックで開ける（開くと作られる）（`web/src/pages/daily/{sidebar,calendar}.tsx`）。今日の日付は `GET /api/notes/today` を staleTime 無限で一度だけ取るので、開いたまま 5 時を越えても「TODAY」は進まない（`web/src/notes/queries.ts:44-53`）。
- essay の一覧はサイドバーの無いカードの grid で、カードは writing のバッジ・title と本文の先頭の preview・日付（`2026/7/21`）。filter は無い。並びは `created_at DESC`（`web/src/api.ts:144` のコメントは updated_at 降順と書いていて食い違う）。右クリックで status の切り替えと削除。
- essay の編集画面のサイドバーは `writing N` と `finished N` のタブと、その中の一覧。status は StatusChip のクリックか ⌃W で切り替える。
- project の候補は `GET /api/projects`（projects 表を `ORDER BY id`）で、label は name、空なら id。サイドバーは「Project」の label、primary の行、区切り、時系列の一覧（日付は出さず、hover で削除の ×）。1 ページ 100 件。project note を作るのは ⌥N だけで、ボタンは無い。
- settings の画面で設定できるのは Day boundary だけ（`web/src/pages/settings/index.tsx:103-148`）。
- notes の画面に検索の欄は無い。note を探す API は `[[` の mention menu が使う `GET /api/notes/mentions?q=`（最大 20 件）だけ。
- localStorage の key は `monica-theme`・`monica-ambient`・`monica-note-extra-w`・`monica-notes-sidebar-w`・`monica-notes-density`・`monica-projects-last` の 6 つ。

### キーの細部

- ⌃1〜3、⌥B、⌥;（ambient の巡回。⇧ で逆順、変換中も効く）は全画面。⌥D は NotesShell の 3 画面。⌥N・⌥Z は essay の一覧と編集と project の編集で、daily には無い。⌥Backspace（と ⌥Delete）は essay と project の編集で、primary の上では素通しする。
- ⌥Backspace は確認を出さずに開いている note を削除する（`web/src/pages/essays/editor.tsx:304-310`）。capture phase で preventDefault するので、本文の中で macOS の単語の削除は使えない。
- ⌥Z の取り消しの stack は、essay では module の変数で一覧と編集が共有し、project では component の ref で project を切り替えると空になる。
- block-editor のキー（⌘J / ⌃J の slash menu、Esc と ⌘A のブロック選択、⌥. の折りたたみ、⌃A / ⌃E / ⌃D / ⌃N / ⌃P、Mod-b / i / u / e など）とは、修飾キーの組み合わせが重ならないようにしているだけで、衝突を避ける仕組みは無い（`web/src/keys.ts:1-2`）。

### 表示名

- daily: サイドバーは今日が `TODAY · TUE 10.6`、ほかは `TUE 10.6`、今年以外は `TUE 2025.10.6`。見出しと競合の通知は `dayLabelWithYear`。mention は ISO の `2026-07-18`（`web/src/notes/dates.ts:42-52`）。
- primary: 見出し・サイドバー・競合の通知は project の name（空なら id）。meta の行に `primary` と出す。mention は title が空なので project_id。
- title の無い essay と project note: 入力欄の placeholder・カード・競合の通知は `Untitled`、サイドバーは preview、それも無ければ `Untitled`。mention は essay が `Untitled`、project note が project_id（primary と同じ表示になる）。
- `document.title` を設定するコードは無く、全画面で `index.html` の `Monica Library` のまま。

## ブラウザへの配り方

- monica desktop が起動時に thread で `monica_web::serve` を立てる（`crates/monica-desktop/src/lib.rs:170-202`）。release は `127.0.0.1:19280` 固定、dev は 19281〜19299 を順に試し、埋まっていれば port 0 にする（`crates/monica-web/src/lib.rs:18-20, 782-793`）。desktop が閉じている間は notes を開けない。
- bind に失敗すると error の log を出し、web server 無しで desktop を動かし続ける。retry も画面への通知も無い（`crates/monica-desktop/src/lib.rs:181-199`）。
- 認証は無い。`Host` が `127.0.0.1:<port>`・`localhost:<port>`・`monica.localhost:<port>`（と Tailscale の IP）のどれかと完全一致しなければ、本文無しの 403 にする。静的ファイルを含む全 route に掛かる。コメントは「認証ではなく DNS rebinding 対策で、到達の制御は bind する interface で行う」（`crates/monica-web/src/lib.rs:82-120, 778`）。
- Origin・`Sec-Fetch-Site`・CSRF token の照合も、CORS の層も無い。content-type を見ない状態変更の route がある（`POST /api/notes/essays`、`POST /api/notes/{id}/restore`、`PUT /api/notes/daily/{date}`、`DELETE /api/notes/{id}`、`POST /api/assets` など）。
- Tailscale の IP が取れればそこにも bind して、tailnet のスマホから開けるようにしている（同 823-845）。tania には持ち込まない（map の決定）。
- SPA は rust-embed で binary に埋め込み、`$MONICA_HOME/web-dist` が directory として在れば request ごとにそちらを優先する（`crates/monica-web/src/lib.rs:28-30, 214-242`）。SPA の route は列挙で、未知の path は 404 になる。`/settings/` は client だけが受け付ける（同 759-775、`web/src/app.tsx:63`）。`index.html` と `/assets/*` に cache の header は無い。
- dev の Vite（5174）は `/api` を backend に proxy する。backend の port は `target/monica-web-port` から読み、dev の backend が居なければ release の `http://monica.localhost:19280` に倒す。そのため Vite だけを動かすと release のデータに読み書きする（`web/vite.config.ts:7, 14-74`）。
- 画面に notes の URL を開く menu や shortcut は無い。Tab の env に `MONICA_WEB_URL` を入れるだけ（`crates/monica-desktop/src/commands/terminal.rs:51-55`）。

## API と CLI

HTTP（`crates/monica-web/src/lib.rs:732-758`）: `GET /api/notes/by-project`、`GET /api/notes/daily-counts`、`PUT /api/notes/daily/{date}`、`GET|POST /api/notes/essays`、`POST /api/notes/project`、`PUT /api/notes/project/primary`、`POST /api/notes/from-markdown`、`POST /api/notes/markdown`、`GET /api/notes/mentions`、`GET /api/notes/mentions/{id}`、`GET /api/notes/today`、`GET|PUT|DELETE /api/notes/{id}`、`PUT /api/notes/{id}/status`、`POST /api/notes/{id}/restore`、`GET /api/notes/{id}/blocks/{block_id}`、`GET /api/ogp`、`GET|PUT /api/settings/notes`、assets の 3 本。

CLI（`crates/monica-cli/src/note.rs`）: `monica note show <id> [--format md|json] [--expand]` と `monica note search <query>`。tania では最初は持ち込まない（map の決定）。CLI は HTTP を経由せず facade を直に呼ぶ。

contract の正は Rust の DTO（`crates/monica-api/src/note.rs`）で、`web/src/types.gen.ts` は specta で生成している。エラーの body は `{code, message}` で、NotFound と Validation（不正な id を含む）が 404、Conflict が 409。web の `ApiError` は status しか見ない。

- `PUT /api/notes/{id}`: body は `{content, title?, expected_updated_at?}`、成功は `{updated_at}` だけ。`expected_updated_at` を省くと無条件に上書きする。title は essay と project のときだけ書き、余計な field は黙って無視する。
- `GET /api/notes/by-project?project_id=&offset=`: offset 方式で 1 頁 100 件、101 件取って `has_more` を出す。web は読み込み済みの件数を次の offset にする。
- `PUT /api/notes/daily/{date}` と `PUT /api/notes/project/primary`: get-or-create で、作っても 200。daily の画面は focus のたびに呼ぶ。
- `PUT /api/notes/{id}/status`: 値を渡す set で、essay 以外は 409。返す `next_status` は DTO だけが足す導出値。
- `POST /api/notes/{id}/restore`: 削除されていない note にも 200 を返す。
- `GET /api/notes/today`: web は staleTime を ∞ にしていて取り直さない（`web/src/notes/queries.ts:44-53`）。
- `GET /api/notes/daily-counts`: web は `?kind=daily` だけで呼び、from と to はテストだけが使う。

エディタの props が呼ぶ route（`web/src/notes/editor-support.ts`）: `fetchLinkMetadata` → `GET /api/ogp`、`searchNoteMentions` → `GET /api/notes/mentions?q=`（debounce なし）、`resolveNoteMention` → `GET /api/notes/mentions/{id}`（開いている note の間だけ cache）、`resolveBlock` → `GET /api/notes/{id}/blocks/{block_id}`（未保存を flush してから取る）、`renderMarkdown` → `POST /api/notes/markdown`（copy に備え、選択が変わるたびに 150ms の debounce で先読みし、16 件を cache する。`expand` は送らない、`shared/block-editor/clipboard.ts:437-520`）、`parseMarkdown` → `POST /api/notes/from-markdown`（text/plain だけの paste）、`uploadImage` → `POST /api/assets`、`importExternalImage` → `POST /api/assets/import`。

## 設定

`settings.json` の `notes.day_boundary_hour`（0〜23、既定 0、実値 5）だけ。効くのは「論理上の今日」の計算（essay と project note の作成時の date、`GET /api/notes/today`）で、過去の note の date は書き換えない。

## 移行に効く事実

2026-10-06 02:58 UTC にコピーした `monica.db` で確かめた（`-wal` と `-shm` は無かった）。前回のコピーからの差は note-160 の本文の更新 1 件だけで、作成と削除は無い。

- 採番: 最大の id は note-160 で、`note_counter` の最大 rowid と `sqlite_sequence` も 160。note-100 は counter に在るが notes に無い。
- 削除済みの 21 件（daily 4・essay 4・project 13）は、生存する note から参照されていない（noteMention・syncedBlock・link の href・text の中の `note-N` を見た）。画像も持たない。削除済みの daily 4 件（note-4・5・18・20）は、どれも生存する daily と date が重なる。削除済みを指す `primary_note_id` は無い。
- 2026-07-20 の daily は note-12（作成 07-19T20:18:06.957Z、442 字、block 13）と note-13（作成 07-20T11:23:54.405Z、更新 12:44:04.269Z、1,897 字、block 32）。block id も 6 字以上の行も重ならず、どちらも参照されていない。
- 時刻: created_at・updated_at・deleted_at はすべて `YYYY-MM-DDTHH:MM:SS.sssZ`、date はすべて `YYYY-MM-DD`。updated_at と created_at が等しい 10 件は、既定の空本文の 10 件と一致する。
- title と status: primary の 5 件はすべて `''`。生存する非 primary の project note 43 件はすべて title を持つ。essay の title は 26 件すべて空でない。essay の status が NULL のものは 3 件（生存は note-7・note-22）。
- project_id は 5 種ですべて小文字。`~/.ghq/src/github.com/<owner>/<repo>` の directory 名と大文字小文字まで一致する。kind=project で project_id が NULL の行は無い。
- 本文: 159 件すべてで `JSON.stringify(JSON.parse(content)) === content` が成り立つ。blockContainer 3,788 個のうち `attrs.id` を持たないのは 11 個で、既定の空本文 10 件と note-1 に 1 個ずつある。
- attrs の形: noteMention は `{noteId}`、syncedBlock は `{blockIds, noteId}`、image は `{src, uploadId, width}`、link mark は `{href}` だけ。

アプリ内 URL の link mark は 10 個で、参照元はすべて生存する note。

| 参照元 | href | 行き先 |
|---|---|---|
| note-17（daily） | `/notes/note-3` | note-3（essay） |
| note-66（daily） | `http://monica.localhost:19280/projects/ashigirl96/monica/notes/note-73` | note-73（project） |
| note-81（daily） | `http://monica.localhost:19280/essays/note-82` | note-82（essay） |
| note-98（project） | `http://monica.localhost:19280/projects/work-org/repo-b/notes/note-97` | note-97（project） |
| note-98（project） | `http://monica.localhost:19280/projects/work-org/repo-b/notes/note-96` | note-96（project） |
| note-75（project） | `http://monica.localhost:19280/explanations/expl-35` | monica の explanations |
| note-79（daily） | `http://monica.localhost:19280/explanations/expl-37` | 同上 |
| note-80（project） | `http://monica.localhost:19280/explanations/expl-38` | 同上 |
| note-116（daily） | `http://monica.localhost:19280/explanations/expl-48` | 同上 |
| note-117（project） | `http://monica.localhost:19280/explanations/expl-47` | 同上 |

- explanations の 5 件は monica.db の explanations 表に実在する。link の文字列は、note-75 と note-117 が URL そのもので、ほかの 3 つは解説の題。
- linkMention と bookmark の href・thumbnail・favicon にアプリ内 URL は無い。`localhost:1928x`・`127.0.0.1`・Tailscale の IP も本文に無い。

画像の 15 枚はすべて png で、名前は小文字の UUID v4。すべて生存する note から相対の `/api/assets/` で参照されている。削除済みの note からだけ参照される画像、参照の無いファイル、ファイルの無い参照は 0。upload の途中の node（`src: null`）も無い。
