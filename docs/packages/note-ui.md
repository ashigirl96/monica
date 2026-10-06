# note の ui

`packages/note/src/ui` に置く notes の画面とエディタ。`@tania/note/ui` から import する。決定の理由は ADR-0019 と #115・#118 の決定にある。今あるのはエディタだけで、画面・router・autosave は後続の issue で足す。

## monica のコードを移すとき

notes の ui は monica の `web/` と `shared/` を移して作る。

- tania の tsconfig（`noUncheckedIndexedAccess`・`erasableSyntaxOnly`）と oxlint（`consistent-function-scoping`・`no-shadow` など）は monica より厳しく、import を書き換えただけでは通らない。parameter property は明示的なフィールドと constructor の先頭での代入に展開する。配列の読み出しは CODING_STANDARDS の「型」に従い、同じ関数の条件から範囲内と読める箇所は `!`、そうでなければ分岐にする。テストも同じ検査を通す。
- 手で入れた変更だけをレビューに見せるには、import の書き換えと oxfmt だけを当てた状態を repo の外に控え、`git diff --no-index <控え> <移した先>` で比べる。
- 振る舞いを変えずに移す slice でも、セキュリティ（スクリプトの実行など）と本文の消失につながる不具合は直し、PR に書く。それ以外の monica の振る舞いはそのまま移し、直すなら別の issue にする。

## エディタ

monica の `shared/block-editor` を `src/ui/editor/` に振る舞いを変えずに移したもの。ProseMirror を直に組み（`new Schema`・`EditorState.create`・`new EditorView`）、NodeView は React ではなく `document.createElement` で組む。entry が出すのは `BlockEditor`（と `BlockEditorHandle`）と、保存の前にアップロード中の画像を外す `stripPendingImages` だけ。

### 置き場所

- note の ui の中に置く。使い手は notes だけで、Note Mention・Synced Block・`/notes/:id` のように note の語を中に持つ。
- domain を持たない package には、2 つ目の使い手が現れるまで切り出さない。`packages/ui` は desktop も読む小さな部品の置き場なので入れない。

### 依存

- `prosemirror-*` の 7 つ（state・model・view・keymap・inputrules・history・commands）を catalog から直に入れる。Milkdown は入れない。monica が使っていた `@milkdown/kit/prose/*` は `prosemirror-*` を `export *` するだけだった。
- 外への import は `react`・`prosemirror-*`・note の `contract.ts` と `ui/routes.ts` だけ。

### node 型と plugin を減らせない理由

- `create-editor.ts` の `docFromJSON` は、`Node.fromJSON` か `check()` に失敗した本文を空の doc にして開く。開いたまま 1 打鍵すると、autosave がその空の doc を保存する。node 型か mark が 1 つでも欠けたエディタは、それを含む保存済みの本文を消す。
- module どうしが循環して import している（`node-views` と `synced-block`、`note-mention-menu` と `clipboard` など）ので、一部の plugin だけを外して持ち込むこともできない。
- 機能を止めたいときは、`BlockEditor` の props を渡さない。`fetchLinkMetadata`・`searchNoteMentions`・`resolveNoteMention`・`resolveBlock`・`uploadImage`・`renderMarkdown`・`parseMarkdown` は、渡さなければその機能が無効になる（`block-editor.tsx`、`create-editor.ts`、`synced-block.ts`）。後続の issue はこの props を 1 つずつ足して機能を有効にする。props は mount 時に固定され、差し替えは `key` を変えた再 mount で行う。

### 直書きの文字列の置き場所

| 文字列 | 置き場所 |
|---|---|
| 画像の URL の prefix（`/api/assets/`） | `@tania/note/contract` の `IMAGE_URL_PREFIX`。notes の口の画像の route も同じ定数を読む |
| Note の path（`/notes/:id`） | `src/ui/routes.ts` の `notePath` と `noteIdOfPath`。Note Mention の href（`noteHref`）と内部リンクの判定（`internalNoteId`）が読む |
| 内部リンクとして扱う host 名 | `@tania/note/contract` の `NOTES_HOSTNAMES`。notes の口の Host の照合も同じ定数を読む |
| clipboard の MIME（`application/x-tania-blocks+json`） | `clipboard.ts` の `BLOCKS_MIME` |

- 内部リンクの判定は、自分の origin の URL に加えて、開いている origin と link の host 名がどちらも `NOTES_HOSTNAMES`（`tania.localhost`・`localhost`・`127.0.0.1`）にあり、scheme と port が同じ URL を内部として扱う。保存される link は `tania.localhost` で書かれるが、ユーザーが同じ Backend を別の名前で開くこともあるため。port が違えば同じ host 名でも外部のリンクになる。
- `import.meta.env.DEV` は残す。dev でだけ IME の debug plugin を入れる。`vite/client` の型は program 全体で効いている。
- エディタは localStorage を使わない。
- link・Link Mention・Bookmark のクリックで開くのは、scheme が `http:`・`https:`・`mailto:` の URL だけ（相対の URL は今の頁を基準に解く。`node-views.ts` の `isOpenableHref`）。本文の link は貼った HTML の href をそのまま持つので、`javascript:` のようなスクリプトを動かす URL も入りうる。

### CSS

- `block-editor.css`（`.jb-*`）を `block-editor.tsx` が import する。ホストから読む CSS 変数は `--foreground`・`--background`・`--popover`・`--popover-foreground` で、`apps/web` の globals.css が置く token（desktop と同じ名前）をそのまま読む。
- 祖先の `[data-density="compact"]` で詰める。
- menu は `view.dom.parentElement` に append するので、ホストの要素は `relative` を持つ必要がある。

### テスト

- `bun test` のままで、DOM の環境は入れない。`EditorState` だけで回し、`EditorView` は型キャストした最小のモックで代える。
- monica のテスト 11 本と `test-fixtures.ts` を移してあり、回帰の網にする。
- 保存済みの本文を開けることは、`src/body/fixtures/full-doc.json`（全 node 型を持つ）を `docFromJSON` に通し、block がすべて残ることで確かめる。
- `src/body/fixtures/unknown-nodes.json` はエディタのテストに使わない。server が知らない node を読み飛ばすことを確かめる fixture で、schema に無い node（`aiHint`・`chart`）と mark（`highlight`）を持つので、エディタでは monica と同じく空の doc になる。monica の本文に出てくる node と mark は、どれも schema にある。
