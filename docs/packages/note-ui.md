# note の ui

`packages/note/src/ui` に置く notes の画面とエディタ。`@tania/note/ui` から import する。決定の理由は ADR-0019 と #115・#118 の決定にある。今あるのはエディタと Daily の画面と見た目の設定で、Essay と Repo の画面は後続の issue で足す。

## monica のコードを移すとき

notes の ui は monica の `web/` と `shared/` を移して作る。

- tania の tsconfig（`noUncheckedIndexedAccess`・`erasableSyntaxOnly`）と oxlint（`consistent-function-scoping`・`no-shadow` など）は monica より厳しく、import を書き換えただけでは通らない。parameter property は明示的なフィールドと constructor の先頭での代入に展開する。配列の読み出しは CODING_STANDARDS の「型」に従い、同じ関数の条件から範囲内と読める箇所は `!`、そうでなければ分岐にする。テストも同じ検査を通す。
- 手で入れた変更だけをレビューに見せるには、import の書き換えと oxfmt だけを当てた状態を repo の外に控え、`git diff --no-index <控え> <移した先>` で比べる。oxfmt は repo の root から控えの directory を指して走らせる。控えの側に設定を置いて走らせると、Tailwind の class の並べ替えが repo の globals.css を引けずに効かず、並びの差が diff に混ざる。
- 振る舞いを変えずに移す slice でも、セキュリティ（スクリプトの実行など）と本文の消失につながる不具合は直し、PR に書く。それ以外の monica の振る舞いはそのまま移し、直すなら別の issue にする。
- monica の画面の判断（保存・競合・取り直し・開き直し）は hook の中にあり、DOM を入れない bun test では守れない。移すときは判断を React に依らない module か純関数に出し、hook はそれを React の状態と event につなぐだけにする（`notes/save-queue.ts`、`notes/note-sync.ts` の `noteToOpen` と `reloadLatest`）。monica の hook には、画面を移る・取り直す間に本文を失う経路が残っていた。
- oxlint の React の規則も monica より厳しい。render 中の `Date` は effect か `useState` の初期化に移し、自分を呼ぶ `useCallback` は名前付きの関数式にする。latch に要る render 中の ref の書き換えと、effect の中での採用は、理由を付けて止める（`notes/note-sync.ts`）。

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
- 機能を止めたいときは、`BlockEditor` の props を渡さない。`fetchLinkMetadata`・`searchNoteMentions`・`resolveNoteMention`・`resolveBlock`・`uploadImage`・`renderMarkdown`・`parseMarkdown` は、渡さなければその機能が無効になる（`block-editor.tsx`、`create-editor.ts`、`synced-block.ts`）。後続の issue はこの props を 1 つずつ足して機能を有効にする。今 `NoteBlockEditor` が渡しているのは、`fetchLinkMetadata` と、Note Mention と Synced Block の props（`searchNoteMentions`・`resolveNoteMention`・`onNoteMentionClick`・`noteId`・`resolveBlock`・`onOpenBlock`）。props の有無は mount 時に固定され、差し替えは `key` を変えた再 mount で行う。
- `fetchLinkMetadata` は note の `linkMetadata` を呼ぶ。link-menu は呼び出しの失敗を値の無い OGP として扱う（monica と同じ）。そのため、取れなかった URL は既定の URL のままなら普通の link、「Mention」を選べば URL を title にした favicon の無い `linkMention`、「Bookmark」を選べば URL だけの `bookmark` になる。

### 直書きの文字列の置き場所

| 文字列 | 置き場所 |
|---|---|
| 画像の URL の prefix（`/api/assets/`） | `@tania/note/contract` の `IMAGE_URL_PREFIX`。notes の口の画像の route も同じ定数を読む |
| Note の path（`/notes/:id`） | `src/ui/routes.ts` の `notePath` と `noteIdOfPath`。Note Mention の href（`noteHref`）と内部リンクの判定（`internalNoteId`）が読む |
| 内部リンクとして扱う host 名 | `@tania/note/contract` の `NOTES_HOSTNAMES`。notes の口の Host の照合も同じ定数を読む |
| clipboard の MIME（`application/x-tania-blocks+json`） | `clipboard.ts` の `BLOCKS_MIME` |
| テーマの localStorage の key（`tania-theme`）と、保存値から light / dark を決める規則 | `src/ui/theme.ts` と `apps/web/index.html` の描画前の script の 2 箇所。index.html の script は描画を止めて走る classic script で、module を import できないため。`theme.test.ts` が index.html の script を走らせ、`setThemePref` と同じテーマになるかを確かめる |

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

## 画面

monica の `web/src` の router・autosave・Daily の画面を移したもの。monica と同じ構成で、`notes/` に画面が共有する部品、`pages/` に画面、`components/` に rail を置く。

### root と apps/web の分担

- root は `NotesApp`（`notes-app.tsx`）。QueryClient を作り、client を React の context に置き、autosave・router・rail・競合の通知・再接続の帯を持つ。
- `apps/web` の main.tsx は、notes の口への RPCLink を作って `client.note` を `NotesApp` に渡すだけで、TanStack Query を知らない。desktop と同じく、domain の ui には自分の client だけを渡す。
- RPCLink には `@tania/note/ui` の `noteLinkOptions` を展開する。keepalive と再接続の合図は link でしか扱えないので、その設定は ui が持つ。client の型は `NoteClient`（note の contract に、`keepalive` を持つ `CallContext` を付けたもの）。

### データ取得

- TanStack Query だけを入れ、`@orpc/tanstack-query` は入れない。queryFn が oRPC の client を呼ぶ。query key は monica のまま（`query.ts` の `queryKeys`）。
- staleTime は 0 で、retry はしない。外の更新は focus のたびに取り直す（ADR-0018）。`focusManager` は visibilitychange に加えて focus と blur を見る。desktop やエディタからブラウザに戻っても窓は見えたままなので、visibilitychange だけでは取り直さないため。
- Daily の画面は focus のたびに `daily.open`（get-or-create）を呼び直す。
- repo の中にデータ取得のやり方が 2 つある。desktop の webview は jotai か useState と domain ごとの変更の stream、notes の画面は TanStack Query と focus での取り直し。

### route

| path | 開くもの |
|---|---|
| `/daily/:date` | その Logical Date の Daily（開くと作られる） |
| `/daily`、`/notes`、`/` | 今日の `/daily/:date` に replace |
| `/notes/:id` | id から種類ごとの path に replace。削除済みと不在は「Note not found」 |
| それ以外 | 「Not found」 |

- path の文字列と route の解釈は `routes.ts` に集める。router は monica の自作を移したもの（`router.ts`、History API）。
- 今日は `/daily` を開くたびに `logicalDate(new Date())` で導く（`todayPath`）。開いたまま 5 時を越えても、次に `/daily` を開けば次の日になる。今日を返す procedure は無い。Daily の画面の TODAY は画面を作った時に導き、`/daily` を開き直すと作り直される。
- `/notes/:id` は `get` で引いた Note の種類から行き先を決める（`notePagePath`）。今は Daily だけが画面を持ち、Essay・Repo Note・Scratch は後続の issue が行き先を足すまで「Not found」。
- rail は Daily / Essays / Repo で、⌃1 / ⌃2 / ⌃3 で移る。Library と Settings は持ち込まない。
- NotesShell のサイドバーは既定 400px で、境界のドラッグで 260〜720px、ダブルクリックで 400px に戻る。幅は画面の間で共有し、localStorage の `tania-notes-sidebar-w` に持つ。
- Daily の表示名の書式は `notes/dates.ts` が持つ。サイドバーは今日が `TODAY · TUE 10.6`、ほかは `TUE 10.6`、今年以外は `TUE 2025.10.6`。見出しと競合の通知は年付きの `dayLabelWithYear`（今年なら年を省く）。
- `document.title` は表示名に ` · tania` を付ける（`TUE 10.6 · tania`）。表示名の無い画面は `tania`。

### 保存と競合

- autosave は router より上で 1 つだけ mount し、画面を移っても pending・基準版・競合を持ち続ける。1 秒の debounce で保存し、送信は直列にし、CONFLICT 以外の失敗は 5 秒ごとに再試行する。判断は React に依らない `notes/save-queue.ts` の `SaveQueue` が持ち、`notes/use-autosave.ts` はそれを React の状態と pagehide・beforeunload につなぐ。
- 保存の `expectedUpdatedAt` には、その Note を最後に読んだか書いた `updatedAt`（基準版）を渡す。版は ms で比べる。Daily と Scratch の保存は title を省く。
- CONFLICT は再試行しない。開いている Note はヘッダのバナー（「最新を読み込む」で手元の編集を捨てる）、開いていない Note は左下の常駐の通知に出す。通知の「開く」は `/notes/:id` に移る。
- 「最新を読み込む」は、取り直しが通ってから手元の編集を捨てて採用する（`reloadLatest`）。取り直しが失敗しても TanStack Query は古い cache を data に残して返すので、先に捨てると編集を失って古い版を出す（monica にあった不具合）。取り直しの間に書いた編集があれば、捨てずに競合のまま残す。取り直しの間に別の Note へ移ったら、返った doc を採用しない（Daily の画面は日を移っても同じ hook を使い続けるため）。
- 未保存の編集がある Note を開き直したら（保存中・再試行待ち・競合中に別の日へ移って戻るなど）、cache の本文ではなく一番新しい未保存の編集を出す（`noteToOpen` と `SaveQueue.unsavedContent`）。cache の本文を使わないので、cache が基準版より古くても開く。版は基準版のままにする。cache に外の新しい版が入っていても基準版を進めないので、保存は CONFLICT になり、外の変更を上書きしない。未保存の本文は autosave にしか無いので、cache で開くと次の打鍵が保存済みの編集を上書きする（monica にあった不具合）。
- 保存は query の cache を通らない。保存の応答は doc を返さないので、cache は 1 世代古くなる。`notes/note-sync.ts` は、基準版より古い cache を採用しない。外の更新は、未保存が無く、基準版より新しいときだけ採用してエディタを作り直す。
- pagehide で未保存を送る。`CallContext` の `keepalive` を link の `fetch` が init に渡す。keepalive の body の上限（64KB）を超える本文は送れない（monica と同じ）。
- `notes/save-state.ts` は monica の `note-ledger.ts` を改名したもの。tania では Ledger を Backend の部品にだけ使う。

### Note Mention と Synced Block

- エディタの props は `notes/note-block-editor.tsx` の `NoteBlockEditor` がまとめて渡し、画面ごとには配線しない。monica は Daily・Essay・Project の 3 つの画面に同じ配線を持っていた。procedure を呼ぶ判断は React に依らない `notes/note-references.ts` の `noteReferences` が持つ。
- `[[` の候補は、打鍵のたびに `noteMention.search` を呼んで取る（debounce なし、monica どおり）。
- Note Mention の表示名は、開いている Note ごとに cache する。`NoteBlockEditor` は Note の id を key に内側を作り直すので、Note を開き直すと引き直す。外の更新を採用してエディタを作り直しても、同じ Note を開いている間は引き直さない（monica どおり）。
- 「Deleted note」と出すのは、Backend が `NOT_FOUND` と答えたときだけ。Backend の答えは `ORPCError` で届くので、それ以外の失敗は届かなかったとみなし、表示を noteId のまま残す。送り直すのは、`Reach.onRecover`（失敗の後に届いた合図）が来てから。失敗してから購読するまでの間に別の request が届いて回復していれば、その合図はもう来ないので、request を出す前に控えた `Reach.recoveries()` と比べてすぐ送り直す。応答はあるのに body を読めない失敗も `ORPCError` にならないので、すぐ送り直すと Backend に届いたまま送り続ける。`NOT_FOUND` 以外の答え（500 など）は送り直さず、noteId のまま残す。monica の web は通信エラーでも「Deleted note」と出していた。
- Synced Block の元の block は、未保存の編集を flush してから `block.get` で取る。別の Note の block は保存済みの本文から取るため。`NOT_FOUND` は「Original block was deleted」、ほかの失敗は Retry の付いた「Failed to load synced block」になり、通信エラーでも再接続を待たない（monica どおり）。同じ Note の Synced Block は Backend を引かず、開いている doc から映す。
- Note Mention の素のクリックは、flush を始めてから `/notes/:id` へ移る。⌘ / ⌃ 付きのクリックは、NodeView が新しいタブで開く。
- 「↗」は Synced Block の先頭の block へ飛ぶ。同じ Note ならその場でスクロールし、別の Note なら飛び先を置いて `/notes/:id` へ移る。移った先の `NoteBlockEditor` が、エディタの mount の後に飛び先を取り出してスクロールする。判断は `notes/block-jump.ts`（`jumpToBlock` と `arrivalAt`）が持つ。
- dev の StrictMode は effect を片付けてから走らせ直し、その間にエディタを作り直す。`arrivalAt` は一度取り出した飛び先を 2 度目にも返すので、作り直したエディタへも飛ぶ。取り出すたびに消すと、1 度目のエディタだけがスクロールして壊され、画面には何も起きない。
- Essay・Repo Note・Scratch はまだ画面を持たないので、それらを指す Note Mention と「↗」は「Not found」に着く。

### 再接続の表示と beforeunload

- 合図は link の fetch の結果（`client.ts` の `linkOptions`）。応答を受け取れば、エラーの応答でも届いたと数え、受け取れなければ届かなかったと数える。abort は数えない。
- 届かなかったら、1 秒ごとに `daily.dates` を呼んで戻ったかを確かめる。最初の失敗から 1 秒たっても届かなければ上端に「tania に再接続中…」を出し、届いたら消す（`reach.ts`）。Backend の再起動（bun --watch で約 100ms）で帯がちらつかないよう、1 秒待つ。
- 失敗の後に届いたら（帯を出す前の短い停止も含む）、エラーのまま残った query を取り直す（`Reach.onRecover`）。retry しないので、届かない間に開いた Daily は、取り直さないと focus し直すまでエラーのまま残るため。
- 届いている間は定期的に呼ばない。そのため、何も操作していない間に Backend が止まっても、次に保存か取り直しが走るまで帯は出ない。
- dev の Vite の proxy は、Backend に届かないとき 502 を返さずに接続を切る。release の口では接続が拒まれるので、どちらでも画面に同じ network error を見せるため。
- 閉じると失われる編集がある間だけ、`beforeunload` でタブを閉じる前に確かめる。数えるのは、競合で残った編集、保存に失敗して再試行を待つ編集、送信中の保存の後ろに待つ編集（pagehide の flush はその保存の後ろに並ぶので、ページと一緒に消える）、届かない間の未保存（debounce 中と送信中）。届く Backend への未保存は pagehide の保存が送るので、書いた直後に閉じても確かめない（`SaveQueue` の `wouldLoseOnLeave`）。
- そのため、書いてから最初の保存が失敗するまでの間に Backend が止まった場合と、keepalive の上限を超える本文を書いた直後に閉じた場合は、確かめずに最後の編集を失う（monica と同じ）。
- IndexedDB への退避と Service Worker は使わない（ADR-0017）。

### CSS

- `notes/notes.css` を NotesShell が import する。面の色（`--desk`・`--paper`・`--ink-*`）を持ち、既定は dark で、light は `:root[data-theme="light"]` で上書きする。
- 机と紙は背景写真（ambient）を透かすため alpha を持ち、写真なし（`:root[data-ambient="none"]`）では不透明にする。
- 背景写真は `.notes-screen::before` が `position: fixed` と負の `z-index` で面の下に敷く。`.notes-screen` に `z-index` や `isolation` を足すと stacking context ができ、写真が面の上に乗る。opacity は `ambient.ts` が light と dark の 2 つを `:root` に流し込み、`notes.css` がテーマで選ぶ。

### 見た目の設定

monica の notes の見た目の設定を、振る舞いを変えずに移したもの。どれもブラウザごとの好みで、Backend には保存しない。

| 設定 | 切り替え | 保存 | 当て方 |
|---|---|---|---|
| テーマ（system / light / dark） | rail の一番下のボタン。押すたびに system → light → dark | `tania-theme`。system のときは key を消す | `:root` の `data-theme`。system は OS の設定を JS で light / dark に解き、OS の切り替えに追従する |
| ambient（none・universe・sakura・village・fireworks・shrine） | 右下のピル、⌥; で次、⇧⌥; で前 | `tania-ambient`。知らない値は universe | `:root` の `data-ambient` と `--ambient`・`--ambient-blur`・`--ambient-opacity-{dark,light}` |
| 本文の幅 | 右下のピルのスライダー。760px に 0〜520px を 8px 刻みで足す | `tania-note-extra-w`。スライダーを離したときに書く | `:root` の `--note-extra-w`。本文の column が `max-w-[calc(760px+var(--note-extra-w,0px))]` で読む |
| 密度（relaxed / compact） | ⌥D | `tania-notes-density` | NotesShell の `data-density`。`block-editor.css` が compact で縦のリズムを詰める（`--jb-line` 32→28px など） |
| zen | ⌥B | 保存しない。reload で解ける | AppShell の `data-zen`。rail とサイドバーを幅 0 にし、右下のピルは残す |

- ⌥B は AppShell が、⌥; は AppShell の中の AmbientSwitcher が取るので全画面で効き、⌥D は NotesShell が取るので NotesShell の画面で効く。どれも `window` の capture phase の `keydown` で取り、エディタより先に横取りする。
- ⌥; だけは変換中も効く。ambient は本文に触らないので、変換中に奪っても害が無いため。⌥B と ⌥D は変換中は効かない。
- テーマは `apps/web` の `index.html` の描画前の script が、最初の描画の前に当てる（上の「直書きの文字列の置き場所」）。ambient と本文の幅は CSS 変数で読むので、`NotesApp` の layout effect が最初の描画の前に当てる。
- App は `/daily` から今日への replace の間も AppShell を外さない。外すと zen が解け、⌃1 で Daily に移るたびに zen を抜ける。
- 写真（JPG、計 1.7MB）は `src/ui/ambients/` に置き、Vite の asset として import する。build では `assets/` に hash 付きで出て、notes の口が immutable の cache で配る。
- 右下のピルの popup は、外側の mousedown、Escape、外の要素への focus で閉じる（`components/use-popup-dismiss.ts`）。Escape は capture phase で取る。bubble では、エディタにいるときに ProseMirror がブロック選択に使って届かないため。

notes の画面が localStorage に書く key は次の 5 つで、どれも `tania-` で始まる。monica の `monica-*` は読まない（origin が違うので、どちらにしても値は引き継がれない）。

| key | 値 |
|---|---|
| `tania-theme` | `light` か `dark` |
| `tania-ambient` | ambient の名前 |
| `tania-note-extra-w` | 本文の幅に足す px |
| `tania-notes-density` | `relaxed` か `compact` |
| `tania-notes-sidebar-w` | NotesShell のサイドバーの幅の px |

### テスト

- エディタと同じく DOM の環境は入れず、純関数と link を確かめる。
- monica の save-state（14 本）・note-sync（10 本）・summary（4 本）のテストを、contract の形（平らな種類、Date の版）に直して移してある。
- 保存は `save-queue.test.ts` が、偽の保存と `spyOn` で捕まえた timer で確かめる（debounce、基準版、CONFLICT、再試行、直列、keepalive、title を省くこと、閉じると失われる編集の数え方）。
- 見た目の設定は、`fake-browser.ts` が置く偽の localStorage・matchMedia・document で確かめる。`theme.test.ts` はテーマを切り替えてから `apps/web/index.html` の描画前の script を走らせ、reload の最初の描画に同じテーマが当たるかを見る。`ambient.test.ts` は保存値の読み方（prototype の名前を弾く）、巡回の向き、⌥; の判定（⇧ で逆順、変換中も効く。`ambientStepOf`）を、`note-width.test.ts` は本文の幅の保存と読み戻しを見る。⌥B と ⌥D、zen、スライダー、密度、写真の見た目は DOM が要るので、ブラウザで確かめる。
- route は `routes.test.ts`（今日の導出、`/notes/:id` の行き先）、再接続は `reach.test.ts`（1 秒の待ちと確かめの request。timer は `setTimeout` を `spyOn` で捕まえて手で進める）、link は `client.test.ts`（keepalive と届いたかの合図。fetch を `spyOn` で差し替える）。
- 本文の中の参照は `note-references.test.ts` が、本物の RPCLink と `Reach` に、path ごとに答えを差し替えた fetch を当てて確かめる（`NOT_FOUND` とほかの答えと通信エラーの分け方、届かない間に送り直さないこと、再接続の後の取り直し、表示名の cache、flush が終わってからの block の取得）。「↗」の飛び先は `block-jump.test.ts`。`NoteBlockEditor` が Note ごとに作り直すことと、クリックで移ることは DOM の無いテストでは見えないので、画面で確かめる。
