# note の ui

`packages/note/src/ui` に置く notes の画面とエディタ。`@monica/note/ui` から import する。決定の理由は ADR-0017・0018・0019 と #115・#118 の決定にある。

## 旧 Monica のコードを移すとき

notes の ui は旧 Monica の `web/` と `shared/` を移して作る。

- monica の tsconfig（`noUncheckedIndexedAccess`・`erasableSyntaxOnly`）と oxlint（`consistent-function-scoping`・`no-shadow` など）は旧 Monica より厳しく、import を書き換えただけでは通らない。parameter property は明示的なフィールドと constructor の先頭での代入に展開する。配列の読み出しは CODING_STANDARDS の「型」に従い、同じ関数の条件から範囲内と読める箇所は `!`、そうでなければ分岐にする。テストも同じ検査を通す。
- 手で入れた変更だけをレビューに見せるには、import の書き換えと oxfmt だけを当てた状態を repo の外に控え、`git diff --no-index <控え> <移した先>` で比べる。oxfmt は repo の root から控えの directory を指して走らせる。控えの側に設定を置いて走らせると、Tailwind の class の並べ替えが repo の globals.css を引けずに効かず、並びの差が diff に混ざる。
- 振る舞いを変えずに移す slice でも、セキュリティ（スクリプトの実行など）と本文の消失につながる不具合は直し、PR に書く。それ以外の旧 Monica の振る舞いはそのまま移し、直すなら別の issue にする。
- 旧 Monica の画面の判断（保存・競合・取り直し・開き直し）は hook の中にあり、DOM を入れない bun test では守れない。移すときは判断を React に依らない module か純関数に出し、hook はそれを React の状態と event につなぐだけにする（`notes/save-queue.ts`、`notes/note-sync.ts` の `noteToOpen` と `reloadLatest`）。旧 Monica の hook には、画面を移る・取り直す間に本文を失う経路が残っていた。
- 旧 Monica は change stream で cache を取り直していたが、monica が取り直すのは focus のときだけ（ADR-0018）。移すときは、旧 Monica の画面が change stream で新しくしていた表示（一覧の preview や title）を数え、手元の cache に写す（`notes/summary.ts` の `withSavedPreview`）。
- 種類ごとの画面を足すときは、Note に紐づく手元の状態（autosave の予約と基準版、draft の本文と title、本文の cache、一覧の cache）を数え、Note を消す経路と開き直す経路のそれぞれで、捨てるか重ねるかを決める（`notes/removals.ts` の `Removals`、`notes/note-sync.ts` の `noteToOpen`）。種類ごとの route は別の種類の id でも開くので、削除のように戻しにくい操作は、開いている Note の種類を確かめてから行う。
- oxlint の React の規則も旧 Monica より厳しい。render 中の `Date` は effect か `useState` の初期化に移し、自分を呼ぶ `useCallback` は名前付きの関数式にする。latch に要る render 中の ref の書き換えと、effect の中での採用は、理由を付けて止める（`notes/note-sync.ts`）。

## エディタ

旧 Monica の `shared/block-editor` を `src/ui/editor/` に振る舞いを変えずに移したもの。ProseMirror を直に組み（`new Schema`・`EditorState.create`・`new EditorView`）、NodeView は React ではなく `document.createElement` で組む。`@monica/note/ui` がエディタから出すのは `BlockEditor`（と `BlockEditorHandle`）と、保存の前にアップロード中の画像を外す `stripPendingImages` だけ。

### 置き場所

- note の ui の中に置く。使い手は notes だけで、Note Mention・Synced Block・`/notes/:id` のように note の語を中に持つ。
- domain を持たない package には、2 つ目の使い手が現れるまで切り出さない。`packages/ui` は desktop も読む小さな部品の置き場なので入れない。

### 依存

- `prosemirror-*` の 7 つ（state・model・view・keymap・inputrules・history・commands）を catalog から直に入れる。Milkdown は入れない。旧 Monica が使っていた `@milkdown/kit/prose/*` は `prosemirror-*` を `export *` するだけだった。
- 外への import は `react`・`prosemirror-*`・note の `contract.ts`・`body`・`ui/routes.ts` だけ。テストは body の fixture と markdown の変換も import する。

### markdown の copy と paste

- `NoteBlockEditor` は `renderMarkdown` に `@monica/note/body` の `toMarkdown` を、`parseMarkdown` に `fromMarkdown` を渡す。どちらも手元で同期に呼ぶ。
- copy は text/plain に markdown を載せる。block 選択の copy は選んだ block を、文字選択の copy と drag は選んだ範囲の slice を書き出す。block 選択の copy は、ほかに `BLOCKS_MIME` と text/html も載せる。
- paste は、text/html を持たない text/plain だけを markdown として読む。code block の中では読まない。読んだ doc が schema に合わなければ素のテキストで入れ、paragraph 1 つだけなら block を割らずにカーソル位置へ入れる。
- 旧 Monica は変換を Backend に頼んでいたので、copy に備えて選択が変わるたびに 150ms 後に変換を先読みして cache し、paste は変換を待つ間の貼り先を plugin state で追っていた。手元で同期に呼べるので、どちらも持ち込まない。
- Note Mention の表示名は、開いている Note の cache から解決し終えたものを `toMarkdown` に渡す（`notes/note-references.ts` の `noteName`）。copy の handler は同期で、解決を待てないため。まだ解決していない Note Mention と、削除した Note を指す Note Mention は `[[note-N]]` で書く。

### paste の menu

- URL の paste で出る link-menu（URL / Mention / Bookmark）と、block の paste で出る paste-menu（Paste / Paste and sync）は、menu の外の doc 変更を「今の表現のまま確定」とみなして閉じる。
- normalizer が block に id を振るだけの transaction（step がすべて attr `id` の `AttrStep`）は、この doc 変更に数えない（`normalizer.ts` の `onlyWritesBlockIds`）。`EMPTY_DOC` から作った Note の最初の段落は id を持たず、貼ったのと同じ dispatch で normalizer が id を振る。数えると menu が出ず、OGP の fetch も始まらない（旧 Monica にあった不具合）。`AttrStep` は位置を動かさないので、menu が持つ位置は mapping せずに使える。
- normalizer が同じ transaction で空の blockGroup を消したり折りたたみを開いたりしたときは、位置が動くので今どおり閉じる。

### node 型と plugin を減らせない理由

- `create-editor.ts` の `docFromJSON` は、`Node.fromJSON` か `check()` に失敗した本文を、例外の message を付けた失敗として返す。画面はその Note をエディタで開かず、読み取り専用で出す（「読めない本文」）。node 型か mark が 1 つでも欠けたエディタでは、それを含む保存済みの本文を編集できなくなる。
- module どうしが循環して import している（`node-views` と `synced-block`、`note-mention-menu` と `clipboard` など）ので、一部の plugin だけを外して持ち込むこともできない。
- 機能を止めたいときは、`BlockEditor` の props を渡さない。`fetchLinkMetadata`・`searchNoteMentions`・`resolveNoteMention`・`resolveBlock`・`uploadImage`・`renderMarkdown`・`parseMarkdown` は、渡さなければその機能が無効になる（`block-editor.tsx`、`create-editor.ts`、`synced-block.ts`）。`NoteBlockEditor` は今この 7 つをすべて渡し、ほかに Note Mention と Synced Block の `onNoteMentionClick`・`noteId`・`onOpenBlock` と、画像の取り込みの `importExternalImage` を渡す。props の有無は mount 時に固定され、差し替えは `key` を変えた再 mount で行う。
- 画像の props は `notes/editor-support.ts` の `imageCallbacks` が作る。どちらも `image.upload` と `image.import` を呼び、失敗は null にする。エディタは upload の失敗を再試行のボタンで、取り込みの失敗を外部 URL のままで見せ、理由では分岐しない。
- `fetchLinkMetadata` は note の `linkMetadata` を呼ぶ。link-menu は呼び出しの失敗を値の無い OGP として扱う（旧 Monica と同じ）。そのため、取れなかった URL は既定の URL のままなら普通の link、「Mention」を選べば URL を title にした favicon の無い `linkMention`、「Bookmark」を選べば URL だけの `bookmark` になる。

### 直書きの文字列の置き場所

| 文字列 | 置き場所 |
|---|---|
| 画像の URL の prefix（`/api/assets/`） | `@monica/note/contract` の `IMAGE_URL_PREFIX`。ブラウザの口の画像の route も同じ定数を読む |
| Note の path（`/notes/:id`） | `src/ui/routes.ts` の `notePath` と `noteIdOfPath`。Note Mention の href（`noteHref`）と内部リンクの判定（`internalNoteId`）が読む |
| 内部リンクとして扱う host 名 | `@monica/note/contract` の `NOTES_HOSTNAMES`。ブラウザの口の Host の照合も同じ定数を読む |
| clipboard の MIME（`application/x-monica-blocks+json`） | `clipboard.ts` の `BLOCKS_MIME` |
| テーマの localStorage の key（`monica-theme`）と、保存値から light / dark を決める規則 | `src/ui/theme.ts` と `apps/web/index.html` の描画前の script の 2 箇所。index.html の script は描画を止めて走る classic script で、module を import できないため。`theme.test.ts` が index.html の script を走らせ、`setThemePref` と同じテーマになるかを確かめる |

- 内部リンクの判定は、自分の origin の URL に加えて、開いている origin と link の host 名がどちらも `NOTES_HOSTNAMES`（`monica.localhost`・`localhost`・`127.0.0.1`）にあり、scheme と port が同じ URL を内部として扱う。保存される link は `monica.localhost` で書かれるが、ユーザーが同じ Backend を別の名前で開くこともあるため。port が違えば同じ host 名でも外部のリンクになる。
- `import.meta.env.DEV` は残す。dev でだけ IME の debug plugin を入れる。`vite/client` の型は program 全体で効いている。
- エディタは localStorage を使わない。
- link・Link Mention・Bookmark のクリックで開くのは、scheme が `http:`・`https:`・`mailto:` の URL だけ（相対の URL は今の頁を基準に解く。`node-views.ts` の `isOpenableHref`）。本文の link は貼った HTML の href をそのまま持つので、`javascript:` のようなスクリプトを動かす URL も入りうる。

### CSS

- `block-editor.css`（`.jb-*`）を `block-editor.tsx` が import する。ホストから読む CSS 変数は `--foreground`・`--background`・`--popover`・`--popover-foreground` で、`apps/web` の globals.css が置く token（desktop と同じ名前）をそのまま読む。
- 祖先の `[data-density="compact"]` で詰める。
- menu は `view.dom.parentElement` に append するので、ホストの要素は `relative` を持つ必要がある。

### テスト

- `bun test` のままで、DOM の環境は入れない。`EditorState` だけで回し、`EditorView` は型キャストした最小のモックで代える。
- 旧 Monica のテスト 11 本と `test-fixtures.ts` を移してあり、回帰の網にする。
- 保存済みの本文を開けることは、`src/body/fixtures/full-doc.json`（全 node 型を持つ）を `docFromJSON` に通し、block がすべて残ることで確かめる。
- markdown の copy と paste は、copy の handler・`clipboardTextSerializer`・`handlePaste` を最小のモックの view で呼んで確かめる。`handlePaste` は `test-fixtures.ts` の `paste` で呼ぶ。dispatch を `state.apply` で当てるので、state に登録した plugin の `appendTransaction` も同じ dispatch で走る。block 選択の copy は text/html を `document` で組むので、そのテストの間だけ組めるだけの偽の `document` を置く。
- paste の menu が開いたままかを確かめる state には、menu の plugin と一緒に normalizer を登録する。登録しないと id を振る transaction が走らず、menu を閉じる経路を通らない。
- 読めない本文は、`docFromJSON` に `src/body/fixtures/unknown-nodes.json` と、`full-doc.json` に子の無い `blockGroup` を足した doc を通し、失敗と例外の message が返ることで確かめる。`unknown-nodes.json` は server が知らない node を読み飛ばすことを確かめる fixture で、schema に無い node（`aiHint`・`chart`）と mark（`highlight`）を持つ。旧 Monica の本文に出てくる node と mark は、どれも schema にある。読めない本文の画面（エディタを出さないこと、保存を送らないこと）は DOM が要るので、ブラウザで確かめる。

## 画面

旧 Monica の `web/src` の router・autosave・Daily と Essay と project の画面を移したもの。project の画面は Repo の画面にした。旧 Monica と同じ構成で、`notes/` に画面が共有する部品、`pages/` に画面、`components/` に rail を置く。

### root と apps/web の分担

- root は `NotesApp`（`notes-app.tsx`）。QueryClient を作り、client を React の context に置き、autosave・router・rail・競合の通知・再接続の帯を持つ。
- `apps/web` の main.tsx は、ブラウザの口への RPCLink を作って `client.note` を `NotesApp` に渡すだけで、TanStack Query を知らない。desktop と同じく、domain の ui には自分の client だけを渡す。
- RPCLink には `@monica/note/ui` の `noteLinkOptions` を展開する。keepalive と再接続の合図は link でしか扱えないので、その設定は ui が持つ。client の型は `NoteClient`（note の contract に、`keepalive` を持つ `CallContext` を付けたもの）。

### データ取得

- TanStack Query だけを入れ、`@orpc/tanstack-query` は入れない。queryFn が oRPC の client を呼ぶ。query key は旧 Monica のまま（`query.ts` の `queryKeys`）。
- staleTime は 0 で、retry はしない。外の更新は focus のたびに取り直す（ADR-0018）。`focusManager` は visibilitychange に加えて focus と blur を見る。desktop やエディタからブラウザに戻っても窓は見えたままなので、visibilitychange だけでは取り直さないため。
- Daily の画面は focus のたびに `daily.open`（get-or-create）を呼び直す。
- repo の中にデータ取得のやり方が 2 つある。desktop の webview は jotai か useState と domain ごとの変更の stream、notes の画面は TanStack Query と focus での取り直し。

### route

| path | 開くもの |
|---|---|
| `/daily/:date` | その Logical Date の Daily（開くと作られる） |
| `/daily`、`/notes`、`/` | 今日の `/daily/:date` に replace |
| `/essays` | Essay の一覧 |
| `/essays/:id` | Essay の編集 |
| `/repos` | 前回の Repo に replace。無ければ Repo の picker |
| `/repos/:owner/:repo` | その Repo の Scratch（開くと作られる） |
| `/repos/:owner/:repo/notes/:id` | Repo Note。その Repo の Repo Note でなければ、その Note の path に replace |
| `/notes/:id` | id から種類ごとの path に replace。削除済み・不在・取れなかったときは「Note not found」 |
| それ以外 | 「Not found」 |

- path の文字列と route の解釈は `routes.ts` に集める。router は旧 Monica の自作を移したもの（`router.ts`、History API）。
- 今日は `/daily` を開くたびに `logicalDate(new Date())` で導く（`todayPath`）。開いたまま 5 時を越えても、次に `/daily` を開けば次の日になる。今日を返す procedure は無い。Daily の画面の TODAY は画面を作った時に導き、`/daily` を開き直すと作り直される。
- `/notes/:id` は `get` で引いた Note の種類から行き先を決める（`notePagePath`）。Daily は `/daily/:date`、Essay は `/essays/:id`、Scratch は `/repos/:owner/:repo`、Repo Note は `/repos/:owner/:repo/notes/:id` に移る。
- `/notes/:id` は行き先へ replace する前に `NoteRedirect` を描くので、Note Mention・↗・競合の通知で同じ画面の中を移るときも、route の木の位置で持つ状態（provider と画面の component の state）は一度 unmount される。画面にいる間の状態を持たせるときは、この中継も同じ位置で囲む（「Essay の画面」の取り消しの stack）。
- rail は Daily / Essay / Repo で、⌃1 / ⌃2 / ⌃3 で移る。Library と Settings は持ち込まない。
- NotesShell のサイドバーは既定 400px で、境界のドラッグで 260〜720px、ダブルクリックで 400px に戻る。幅は画面の間で共有し、localStorage の `monica-notes-sidebar-w` に持つ。
- Daily の表示名の書式は `notes/dates.ts` が持つ。サイドバーは今日が `TODAY · TUE 10.6`、ほかは `TUE 10.6`、今年以外は `TUE 2025.10.6`。見出しと競合の通知は年付きの `dayLabelWithYear`（今年なら年を省く）。
- `document.title` は表示名に ` · monica` を付ける（`TUE 10.6 · monica`、`On ledgers · monica`）。Essay と Repo Note は title（空なら `Untitled`）、Scratch は `owner/repo` で、contract の `displayName` を使う。表示名の無い画面（Essay の一覧など）は `monica`。

### Essay の画面

旧 Monica の `pages/essays` を移したもの（`pages/essays/`）。

- 一覧（`list.tsx`）はサイドバーの無いカードの grid。カードは writing のバッジ、title と preview の紙のミニチュア、日付（Logical Date を `2026/7/21` で。`notes/dates.ts` の `slashDate`）。並びは `essay.list` のまま（`createdAt` の降順）。
- 一覧の右クリックの menu は `@monica/ui` の `PopoverMenu` で、状態の切り替え（「Mark as finished」か「Move to writing」）と削除を出す。`PopoverMenu` が Escape で閉じるので、一覧の画面は Escape を見ない（`docs/packages/desktop.md`）。
- 編集（`editor.tsx`）は NotesShell に載せる。サイドバー（`sidebar.tsx`）は `writing N` と `finished N` のタブと、そのタブの Essay の一覧（title、無題なら preview、それも無ければ `Untitled`。`notes/summary.ts` の `summaryTitle`）。タブは開いた Essay の status に合わせ、⌥H / ⌥L で移す。合わせるのは開いた時と status が変わった時だけで、⌥H / ⌥L で移したタブは引き戻さない。
- 一覧の cache の preview は、保存が通るたびに、保存した本文から Backend と同じ `preview` で作り直す（`summary.ts` の `withSavedPreview`。写すのは autosave）。change stream が無いので、写さないと無題の Essay の見出しが `Untitled` のまま残る。一覧を取り直さないのは、打っている途中の title が保存済みの古い値へ戻るため。
- 本文の上に title の入力欄（空なら placeholder の `Untitled`）、status の StatusChip、日付、保存の状態を置く。title は本文と同じ autosave で保存する。title で Enter・↓・Tab・⌃N を押すと本文の先頭へ、本文の先頭で ↑ を押すと title へ移る。
- 状態は StatusChip のクリックか ⌃W で切り替える。次の status は画面が今の status から導き（`support.ts` の `nextEssayStatus`）、`essay.setStatus` に値で渡す。連打は直列にし、2 回目は 1 回目の結果から導く。
- 状態の切り替えも削除（「削除と取り消し」）と同じく、先に flush して未保存が残れば中止する（`pages/essays/actions.ts` の `setOpenEssayStatus`）。状態の切り替えで進んだ版を基準版にすると、競合で残った古い本文が次の保存で外の変更を上書きするため。一覧の右クリックでも、削除は同じく flush してから消す。状態の切り替えは旧 Monica どおり flush しない。
- 状態を切り替えた版は、返った本文と title が送る前の画面と同じとき（status だけが変わった版）に基準版にする。手元の本文はその上に積んでよい。違えば外で書き換わった版で、基準版にすると画面の古い本文が次の保存でその変更を競合なしに上書きする（旧 Monica にあった不具合）。そのときは、未保存が無ければ返った Note でエディタを mount し直し、未保存があれば基準版を進めずに、保存の CONFLICT に拾わせる。
- 往復の間に本文か title を書いていたら、返った Note の status だけを取り、本文と title は手元のまま残す（旧 Monica は title も返った値で上書きした）。往復の間に別の Note へ移っていたら、返った Note を画面に採用しない。
- 消せた後の移り先は、編集では表示中のタブの次の Essay、タブに無ければ一覧で、どちらも replace で移る。一覧の右クリックで消したときは、待つ間にその Essay を開いていたときだけ一覧へ戻る。
- `/essays/:id` は Essay 以外の id でも開き、本文の代わりに「Not an essay — open it in Notes」を出す。そこでは削除も状態の切り替えもしない。削除は `Removals` が種類を見て断る。⌥Backspace は取ったまま何もしない。その Note のエディタが無く、単語の削除に渡す先が無いため。
- ⌥N と ⌥Z は、往復の間に別の画面へ移っていても、作った Essay と戻した Essay を開く（旧 Monica どおり）。開くことがその操作の目的で、画面を移っても autosave は router の上で保存を続けるので、本文は失われない。

| キー | 画面 | すること |
|---|---|---|
| ⌥N | 一覧と編集 | Essay を作って開く。編集から作ると title の入力欄から書き始める |
| ⌥Backspace、⌥Delete | 編集 | 開いている Essay を確認なしで削除する。表示中のタブにあれば次の Essay、無ければ一覧へ replace する |
| ⌥Z | 一覧と編集 | 最後に削除した Essay を戻す。編集では戻した Essay を開く |
| ⌃W | 編集 | status を切り替える |
| ⌥H、⌥L | 編集 | サイドバーのタブを移す。開いている Essay と URL は動かさない |
| ⌥J、⌥K | 編集 | 表示中のタブの中で次と前の Essay を開く |

- キーは window の capture phase の keydown で取るので、⌥Backspace は本文の中でも削除になり、macOS の単語の削除は使えない（旧 Monica どおり）。
- 取り消しの stack は、`app.tsx` で一覧と編集と `/notes/:id` の route を 1 つに囲む `EssayRemovalsProvider`（`pages/essays/removals.tsx`）の `Removals` が持つ。一覧と編集を行き来しても provider は mount されたまま残るので、一覧の右クリックで消したものも編集の ⌥Z で、編集で消したものも一覧の ⌥Z で戻る。Note Mention・↗・競合の通知で別の Essay へ移るときは `/notes/:id` を通るので、そこも囲まないと Essay の画面の中で stack を捨てる。Daily や Repo へ移ると provider ごと捨てるので、Essay の画面に戻ってから ⌥Z を押しても戻らない。頁を読み込み直しても戻らない。

### Repo の画面

- 旧 Monica の `pages/projects` を `pages/repos` に移したもの。「Project」の label は「Repo」に、primary は Scratch に、meta の行の `primary` は `scratch` にした。
- Scratch を上に固定し、その下に Repo Note を `repoNote.list` の頁で無限スクロールに並べる（`docs/packages/note-ledger.md`）。サイドバーは「Repo」の label、Scratch の行、区切り、Repo Note の一覧（日付は出さず、hover で削除の ×）。
- Scratch の見出しとサイドバーの行は `owner/repo`（Scratch が持つ綴り）。Repo Note の行は title、無題なら preview、どちらも無ければ `Untitled`（`notes/summary.ts` の `summaryTitle`。旧 Monica と同じ）。Repo Note の title の欄の placeholder は `Untitled`。
- 前回の Repo は localStorage の `monica-repos-last` に持ち、`/repos` は Repo の候補を待たずにそこへ移る。候補は ghq を spawn し、取るのに数秒かかりうるため。
- Repo の候補は picker（`@monica/ui` の `FuzzyPickerModal`）を開いている間だけ取る。選ぶとその Repo の Scratch が作られるので、一度開いただけの Repo にも空の Scratch が残る。これは受け入れる。
- キー（capture phase で ProseMirror より先に取る）:
  - ⌃W: Repo の picker を開く。
  - ⌥N: Repo Note を作って開き、title の欄から書き始める。
  - ⌥Backspace と ⌥Delete: 開いている Repo Note を確認なしで削除して Scratch に移る。Scratch の上では素通しし、エディタの単語の削除になる。
  - ⌥Z: 削除を取り消してその Repo Note を開く。
  - ⌥J / ⌥K: Scratch と Repo Note を巡回する。
- 削除と取り消しは「削除と取り消し」の `Removals` を `RepoEditor` が mount ごとに持つ。取り消しの stack は `RepoEditor` の寿命の間だけ持ち、Repo を切り替えると画面ごと作り直すので空になる（旧 Monica と同じ）。Note Mention などで同じ Repo の Repo Note へ移るときも、`/notes/:id` の中継で作り直すので空になる。頁を読み込み直しても空になる。
- 消せたら、待った後の URL が消した Note を指すときだけ Scratch へ replace で移る。サイドバーの × で消している間に、その Note を開いて書くことがあるため。
- 別のタブで消された Repo Note は、取り直しの `NOT_FOUND` で、このタブで消したときと同じく保存の予約を捨てて Scratch へ移る。開いた本文を出し続けると、書いた分の保存が `NOT_FOUND` で再試行され続ける。開いた本文の無い（URL から直に開いた）消えた Note は、エラーを出す。
- Scratch の保存は title を省く。server は title の付いた Scratch の保存を本文ごと断る。

### 読めない本文

エディタの schema で読めない本文（`docFromJSON` が失敗を返すもの）の Note は、Daily・Essay・Repo のどの画面でもエディタを mount しない。空の doc で開くと、1 打鍵で autosave がその空の doc を元の本文の上に保存するため（旧 Monica にあった不具合）。

- 本文の代わりに、`@monica/note/body` の `toMarkdown` で書き出した本文を、選択できる読み取り専用のテキストで出す。schema に無い node は表示から落ちるが、DB の本文はそのまま残る。
- ヘッダに「この本文はエディタで開けません」と ProseMirror の例外の message を出し、同じ message を `console.error` にも出す（`notes/note-body.tsx`）。
- その Note には本文も title も保存しない。title の欄は読み取り専用にし、各画面の保存の予約（Essay と Repo の `scheduleSave`、Daily の `onDocChange`）も本文が読めるかを見て止める。Essay の状態の切り替え、削除、取り消しは本文に触れないので、読める Note と同じく動く。
- 外の更新は今の採用の経路で受ける。focus で取り直して読める版が来ればエディタで開き直し、読めない版を採用すれば読み取り専用に切り替わる。
- 本文は Note の本文の object ごとに 1 度だけ読む（`readBody`）。`scheduleSave` は打鍵のたびに読めるかを見るため。
- 本文が `null` か `undefined` なら、空の doc で開く。

### 削除と取り消し

Essay と Repo Note の削除と ⌥Z の判断は `notes/removals.ts` の `Removals` が持ち、Essay の一覧と編集、Repo の画面が使う。`Removals` は React に依らず、`notes/use-removals.ts` の `useRemovals` が autosave と client と本文の cache につなぐ。一覧の cache の書き直しと、戻した Note の seed と移動は画面が行う。

- 先に flush し、消す Note の未保存の編集が残れば消さない。⌥Z で戻せるのは Backend に届いた本文までなので、残したまま消すとその編集を失う。
- 消せたら、autosave の予約（`discard`）と本文の cache（`useForgetNote`）を捨て、取り消しの stack に積む。予約が残ると保存が NOT_FOUND で再試行を繰り返し、cache が残ると履歴で戻ったときに消した Note を cache から開いて、保存だけが失敗し続ける。消す前に flush して未保存が無いのを確かめ、消した後にも見直すので、予約を捨てても編集は失われない。
- 消す往復の間にその Note を開いて打った分があれば、`restore` で戻して消さなかったことにし、打った分を戻した Note へ保存させる。戻せなかったときは消したままにし、打った分は捨てて stack に積む。
- 開いている Note を消す間は、エディタの `noteRef` を外して保存の予約を締める。待つ間の打鍵を予約すると flush の成否に入らず、消した後の保存が NOT_FOUND を繰り返す。消せなかったら、`noteRef` が空のまま、かつ URL がまだその Note を指すときだけ開き直し、締めている間の打鍵を保存し直す。待つ間に別の Note へ移った後に開き直すと、その Note の打鍵が消せなかった Note へ保存される（旧 Monica にあった不具合）。
- 消せた後に画面の移り先へ移るのは、待った後の URL が消した Note を指すときだけ。移り先は画面が渡す。
- 開いているかは、prop や effect で写した ref ではなく URL で見る（`routes.ts` の `openNoteIdOfPath`）。`navigate` は URL をその場で書き換えるが、prop と ref が追いつくのは描画の後なので、その間に削除が返ると、移った先から移り先へ移ったり、移った先の打鍵を消せなかった Note へ予約したりする。
- `Removals` は自分が消す種類（`essay` か `repo_note`）を持ち、開いている Note の種類が違えば消さない。`remove` は Essay も Repo Note も消せる種類として受け、種類ごとの route は別の種類の id でも開くので、種類を見ないと Essay の画面から Repo Note を消してしまう（旧 Monica にあった不具合）。
- ⌥Z は stack の最後の Note を戻し、autosave の `resume` で、削除で止めた保存の再試行を戻す（旧 Monica の Essay の一覧の ⌥Z は戻さなかった）。戻せなかった id は抜いた位置に戻し、次の ⌥Z で試し直せるようにする。末尾に戻すと、待つ間に積まれた削除より後になり、削除の順が崩れる。
- 取り消しの stack は、削除した画面にいる間だけ持つ（`GLOSSARY.md` の Note）。`Removals` を持つ component が unmount されると stack も捨てる。stack は手元のメモリにしか無いので、頁を読み込み直すと取り消せない。

### 保存と競合

- autosave は router より上で 1 つだけ mount し、画面を移っても pending・基準版・競合を持ち続ける。1 秒の debounce で保存し、送信は直列にし、CONFLICT 以外の失敗は 5 秒ごとに再試行する。判断は React に依らない `notes/save-queue.ts` の `SaveQueue` が持ち、`notes/use-autosave.ts` はそれを React の状態と pagehide・beforeunload につなぐ。
- 保存の `expectedUpdatedAt` には、その Note を最後に読んだか書いた `updatedAt`（基準版）を渡す。版は ms で比べる。Daily と Scratch の保存は title を省く。
- CONFLICT は再試行しない。開いている Note はヘッダのバナー（「最新を読み込む」で手元の編集を捨てる）、開いていない Note は左下の常駐の通知に出す。通知の「開く」は `/notes/:id` に移る。
- 「最新を読み込む」は、取り直しが通ってから手元の編集を捨てて採用する（`reloadLatest`）。取り直しが失敗しても TanStack Query は古い cache を data に残して返すので、先に捨てると編集を失って古い版を出す（旧 Monica にあった不具合）。取り直しの間に書いた編集があれば、捨てずに競合のまま残す。取り直しの間に別の Note へ移ったら、返った doc を採用しない（Daily の画面は日を移っても同じ hook を使い続けるため）。
- 未保存の編集がある Note を開き直したら（保存中・再試行待ち・競合中に別の日へ移って戻るなど）、cache の本文と title ではなく一番新しい未保存の編集を出す（`noteToOpen` と `SaveQueue.unsavedDraft`）。title も重ねるのは、cache の title で開くと次の打鍵の draft が未保存の title を古い title で置き換えるため。cache の本文を使わないので、cache が基準版より古くても開く。版は基準版のままにする。cache に外の新しい版が入っていても基準版を進めないので、保存は CONFLICT になり、外の変更を上書きしない。未保存の本文は autosave にしか無いので、cache で開くと次の打鍵が保存済みの編集を上書きする（旧 Monica にあった不具合）。
- 保存は query の cache を通らない。保存の応答は doc を返さないので、cache は 1 世代古くなる。`notes/note-sync.ts` は、基準版より古い cache を採用しない。外の更新は、未保存が無く、基準版より新しいときだけ採用してエディタを作り直す。
- pagehide で未保存を送る。`CallContext` の `keepalive` を link の `fetch` が init に渡す。keepalive の body の上限（64KB）を超える本文は送れない（旧 Monica と同じ）。
- `notes/save-state.ts` は旧 Monica の `note-ledger.ts` を改名したもの。monica では Ledger を Backend の部品にだけ使う。

### Note Mention と Synced Block

- エディタの props は `notes/note-block-editor.tsx` の `NoteBlockEditor` がまとめて渡し、画面ごとには配線しない。旧 Monica は Daily・Essay・Project の 3 つの画面に同じ配線を持っていた。procedure を呼ぶ判断は React に依らない `notes/note-references.ts` の `noteReferences` が持つ。
- `[[` の候補は、打鍵のたびに `noteMention.search` を呼んで取る（debounce なし、旧 Monica どおり）。
- Note Mention の表示名は、開いている Note ごとに cache する。`NoteBlockEditor` は Note の id を key に内側を作り直すので、Note を開き直すと引き直す。外の更新を採用してエディタを作り直しても、同じ Note を開いている間は引き直さない（旧 Monica どおり）。
- 「Deleted note」と出すのは、Backend が `NOT_FOUND` と答えたときだけ。Backend の答えは `ORPCError` で届くので、それ以外の失敗は届かなかったとみなし、表示を noteId のまま残す。送り直すのは、`Reach.onRecover`（失敗の後に届いた合図）が来てから。失敗してから購読するまでの間に別の request が届いて回復していれば、その合図はもう来ないので、request を出す前に控えた `Reach.recoveries()` と比べてすぐ送り直す。応答はあるのに body を読めない失敗も `ORPCError` にならないので、すぐ送り直すと Backend に届いたまま送り続ける。`NOT_FOUND` 以外の答え（500 など）は送り直さず、noteId のまま残す。旧 Monica の web は通信エラーでも「Deleted note」と出していた。
- Synced Block の元の block は、未保存の編集を flush してから `block.get` で取る。別の Note の block は保存済みの本文から取るため。`NOT_FOUND` は「Original block was deleted」、ほかの失敗は Retry の付いた「Failed to load synced block」になり、通信エラーでも再接続を待たない（旧 Monica どおり）。同じ Note の Synced Block は Backend を引かず、開いている doc から映す。
- Note Mention の素のクリックは、flush を始めてから `/notes/:id` へ移る。⌘ / ⌃ 付きのクリックは、NodeView が新しいタブで開く。
- 「↗」は Synced Block の先頭の block へ飛ぶ。同じ Note ならその場でスクロールし、別の Note なら飛び先を置いて `/notes/:id` へ移る。移った先の `NoteBlockEditor` が、エディタの mount の後に飛び先を取り出してスクロールする。判断は `notes/block-jump.ts`（`jumpToBlock` と `arrivalAt`）が持つ。
- dev の StrictMode は effect を片付けてから走らせ直し、その間にエディタを作り直す。`arrivalAt` は一度取り出した飛び先を 2 度目にも返すので、作り直したエディタへも飛ぶ。取り出すたびに消すと、1 度目のエディタだけがスクロールして壊され、画面には何も起きない。
- Note Mention と「↗」は、`/notes/:id` から指す Note の種類の画面へ移る（「route」）。

### 再接続の表示と beforeunload

- 合図は link の fetch の結果（`client.ts` の `linkOptions`）。応答を受け取れば、エラーの応答でも届いたと数え、受け取れなければ届かなかったと数える。abort は数えない。
- 届かなかったら、1 秒ごとに `daily.dates` を呼んで戻ったかを確かめる。最初の失敗から 1 秒たっても届かなければ上端に「monica に再接続中…」を出し、届いたら消す（`reach.ts`）。Backend の再起動（bun --watch で約 100ms）で帯がちらつかないよう、1 秒待つ。
- 失敗の後に届いたら（帯を出す前の短い停止も含む）、エラーのまま残った query を取り直す（`Reach.onRecover`）。retry しないので、届かない間に開いた Daily は、取り直さないと focus し直すまでエラーのまま残るため。
- 届いている間は定期的に呼ばない。そのため、何も操作していない間に Backend が止まっても、次に保存か取り直しが走るまで帯は出ない。
- dev の Vite の proxy も、Backend に届かないときは接続を切り、release の口と同じ network error を見せる（`docs/packages/dev-loop.md` の「dev loop」）。
- 閉じると失われる編集がある間だけ、`beforeunload` でタブを閉じる前に確かめる。数えるのは、競合で残った編集、保存に失敗して再試行を待つ編集、送信中の保存の後ろに待つ編集（pagehide の flush はその保存の後ろに並ぶので、ページと一緒に消える）、届かない間の未保存（debounce 中と送信中）。届く Backend への未保存は pagehide の保存が送るので、書いた直後に閉じても確かめない（`SaveQueue` の `wouldLoseOnLeave`）。
- そのため、書いてから最初の保存が失敗するまでの間に Backend が止まった場合と、keepalive の上限を超える本文を書いた直後に閉じた場合は、確かめずに最後の編集を失う（旧 Monica と同じ）。
- IndexedDB への退避と Service Worker は使わない（ADR-0017）。

### CSS

- `notes/notes.css` を NotesShell が import する。面の色（`--desk`・`--paper`・`--ink-*`）を持ち、既定は dark で、light は `:root[data-theme="light"]` で上書きする。
- 机と紙は背景写真（ambient）を透かすため alpha を持ち、写真なし（`:root[data-ambient="none"]`）では不透明にする。
- 背景写真は `.notes-screen::before` が `position: fixed` と負の `z-index` で面の下に敷く。`.notes-screen` に `z-index` や `isolation` を足すと stacking context ができ、写真が面の上に乗る。opacity は `ambient.ts` が light と dark の 2 つを `:root` に流し込み、`notes.css` がテーマで選ぶ。

### 見た目の設定

旧 Monica の notes の見た目の設定を、振る舞いを変えずに移したもの。どれもブラウザごとの好みで、Backend には保存しない。

| 設定 | 切り替え | 保存 | 当て方 |
|---|---|---|---|
| テーマ（system / light / dark） | rail の一番下のボタン。押すたびに system → light → dark | `monica-theme`。system のときは key を消す | `:root` の `data-theme`。system は OS の設定を JS で light / dark に解き、OS の切り替えに追従する |
| ambient（none・universe・sakura・village・fireworks・shrine） | 右下のピル、⌥; で次、⇧⌥; で前 | `monica-ambient`。知らない値は universe | `:root` の `data-ambient` と `--ambient`・`--ambient-blur`・`--ambient-opacity-{dark,light}` |
| 本文の幅 | 右下のピルのスライダー。760px に 0〜520px を 8px 刻みで足す | `monica-note-extra-w`。スライダーを離したときに書く | `:root` の `--note-extra-w`。本文の column が `max-w-[calc(760px+var(--note-extra-w,0px))]` で読む |
| 密度（relaxed / compact） | ⌥D | `monica-notes-density` | NotesShell の `data-density`。`block-editor.css` が compact で縦のリズムを詰める（`--jb-line` 32→28px など） |
| zen | ⌥B | 保存しない。reload で解ける | AppShell の `data-zen`。rail とサイドバーを幅 0 にし、右下のピルは残す |

- ⌥B は AppShell が、⌥; は AppShell の中の AmbientSwitcher が取るので全画面で効き、⌥D は NotesShell が取るので NotesShell の画面で効く。どれも `window` の capture phase の `keydown` で取り、エディタより先に横取りする。
- ⌥; だけは変換中も効く。ambient は本文に触らないので、変換中に奪っても害が無いため。⌥B と ⌥D は変換中は効かない。
- テーマは `apps/web` の `index.html` の描画前の script が、最初の描画の前に当てる（上の「直書きの文字列の置き場所」）。ambient と本文の幅は CSS 変数で読むので、`NotesApp` の layout effect が最初の描画の前に当てる。
- App は `/daily` から今日への replace の間も AppShell を外さない。外すと zen が解け、⌃1 で Daily に移るたびに zen を抜ける。
- 写真（JPG、計 1.7MB）は `src/ui/ambients/` に置き、Vite の asset として import する。build では `assets/` に hash 付きで出て、ブラウザの口が immutable の cache で配る。
- 右下のピルの popup は、外側の mousedown、Escape、外の要素への focus で閉じる（`components/use-popup-dismiss.ts`）。Escape は capture phase で取る。bubble では、エディタにいるときに ProseMirror がブロック選択に使って届かないため。

notes の画面が localStorage に書く key は次の 6 つで、どれも `monica-` で始まる。旧 Monica の `monica-*` は読まない（origin が違うので、どちらにしても値は引き継がれない）。

| key | 値 |
|---|---|
| `monica-theme` | `light` か `dark` |
| `monica-ambient` | ambient の名前 |
| `monica-note-extra-w` | 本文の幅に足す px |
| `monica-notes-density` | `relaxed` か `compact` |
| `monica-notes-sidebar-w` | NotesShell のサイドバーの幅の px |
| `monica-repos-last` | 前回開いた Repo の `owner/repo` |

### テスト

- エディタと同じく DOM の環境は入れず、純関数と link を確かめる。
- 旧 Monica の save-state（14 本）・note-sync（10 本）・summary（4 本）のテストを、contract の形（平らな種類、Date の版）に直して移してある。summary には `summaryTitle` の 1 本と `withSavedPreview` の 2 本を、note-sync には `reloadLatest` の 4 本と `noteToOpen` の 5 本を足してある。
- 保存は `save-queue.test.ts` が、偽の保存と `spyOn` で捕まえた timer で確かめる（debounce、基準版、CONFLICT、再試行、直列、keepalive、title を省くこと、閉じると失われる編集の数え方）。
- Essay の画面は `support.test.ts` と `actions.test.ts` で確かめる。`support.test.ts` は、旧 Monica の `pages/essays/support.test.ts`（7 本）を contract の形に直して移したもの。`actions.test.ts` は、状態の切り替えの判断を偽の保存の口で確かめる。確かめるのは、flush が返るまで待ってから未保存を見ること、残れば中止すること、往復の間の編集と移動、外で書き換わった版を基準版にしないこと。
- 削除と取り消しは `removals.test.ts` が、偽の保存と procedure と URL で、Essay と Repo Note の両方の種類について確かめる（flush を待ってから未保存を見ること、消す往復の間の打鍵で戻すこと、予約と本文の cache を捨てること、待つ間の打鍵と移動、種類を見ること、移り先へ移る条件、⌥Z の順と失敗した ⌥Z の戻し先）。一覧と編集と `/notes/:id` を行き来しても stack が残ることと、ほかの section へ移ると捨てることは、provider の mount で決まり、DOM の無いテストでは見えないので、画面で確かめる。
- 見た目の設定は、`fake-browser.ts` が置く偽の localStorage・matchMedia・document で確かめる。`theme.test.ts` はテーマを切り替えてから `apps/web/index.html` の描画前の script を走らせ、reload の最初の描画に同じテーマが当たるかを見る。`ambient.test.ts` は保存値の読み方（prototype の名前を弾く）、巡回の向き、⌥; の判定（⇧ で逆順、変換中も効く。`ambientStepOf`）を、`note-width.test.ts` は本文の幅の保存と読み戻しを見る。⌥B と ⌥D、zen、スライダー、密度、写真の見た目は DOM が要るので、ブラウザで確かめる。
- route は `routes.test.ts`（今日の導出、`/notes/:id` の行き先、Repo の path で開いた Note の行き先、URL が開いている Note）、再接続は `reach.test.ts`（1 秒の待ちと確かめの request。timer は `setTimeout` を `spyOn` で捕まえて手で進める）、link は `client.test.ts`（keepalive と届いたかの合図。fetch を `spyOn` で差し替える）。
- 本文の中の参照は `note-references.test.ts` が、本物の RPCLink と `Reach` に、path ごとに答えを差し替えた fetch を当てて確かめる（`NOT_FOUND` とほかの答えと通信エラーの分け方、届かない間に送り直さないこと、再接続の後の取り直し、表示名の cache、copy が同期に引く解決済みの表示名、flush が終わってからの block の取得）。「↗」の飛び先は `block-jump.test.ts`。`NoteBlockEditor` が Note ごとに作り直すことと、クリックで移ることは DOM の無いテストでは見えないので、画面で確かめる。
