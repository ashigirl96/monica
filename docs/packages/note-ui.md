# note の ui

`packages/note/src/ui` に置く notes の画面とエディタ。`@tania/note/ui` から import する。決定の理由は ADR-0019 と #115・#118 の決定にある。今あるのはエディタと Daily と Essay の画面で、Repo の画面、テーマと ambient は後続の issue で足す。

## monica のコードを移すとき

notes の ui は monica の `web/` と `shared/` を移して作る。

- tania の tsconfig（`noUncheckedIndexedAccess`・`erasableSyntaxOnly`）と oxlint（`consistent-function-scoping`・`no-shadow` など）は monica より厳しく、import を書き換えただけでは通らない。parameter property は明示的なフィールドと constructor の先頭での代入に展開する。配列の読み出しは CODING_STANDARDS の「型」に従い、同じ関数の条件から範囲内と読める箇所は `!`、そうでなければ分岐にする。テストも同じ検査を通す。
- 手で入れた変更だけをレビューに見せるには、import の書き換えと oxfmt だけを当てた状態を repo の外に控え、`git diff --no-index <控え> <移した先>` で比べる。
- 振る舞いを変えずに移す slice でも、セキュリティ（スクリプトの実行など）と本文の消失につながる不具合は直し、PR に書く。それ以外の monica の振る舞いはそのまま移し、直すなら別の issue にする。
- monica の画面の判断（保存・競合・取り直し・開き直し）は hook の中にあり、DOM を入れない bun test では守れない。移すときは判断を React に依らない module か純関数に出し、hook はそれを React の状態と event につなぐだけにする（`notes/save-queue.ts`、`notes/note-sync.ts` の `noteToOpen` と `reloadLatest`）。monica の hook には、画面を移る・取り直す間に本文を失う経路が残っていた。
- monica は change stream で cache を取り直していたが、tania が取り直すのは focus のときだけ（ADR-0018）。移すときは、monica の画面が change stream で新しくしていた表示（一覧の preview や title）を数え、手元の cache に写す（`notes/summary.ts` の `withSavedPreview`）。
- 種類ごとの画面を足すときは、Note に紐づく手元の状態（autosave の予約と基準版、draft の本文と title、本文の cache、一覧の cache）を数え、Note を消す経路と開き直す経路のそれぞれで、捨てるか重ねるかを決める（`pages/essays/editor.tsx` の削除、`notes/note-sync.ts` の `noteToOpen`）。種類ごとの route は別の種類の id でも開くので、削除のように戻しにくい操作は、開いている Note の種類を確かめてから行う。
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

## 画面

monica の `web/src` の router・autosave・Daily と Essay の画面を移したもの。monica と同じ構成で、`notes/` に画面が共有する部品、`pages/` に画面、`components/` に rail を置く。

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
| `/essays` | Essay の一覧 |
| `/essays/:id` | Essay の編集 |
| `/notes/:id` | id から種類ごとの path に replace。削除済みと不在は「Note not found」 |
| それ以外 | 「Not found」 |

- path の文字列と route の解釈は `routes.ts` に集める。router は monica の自作を移したもの（`router.ts`、History API）。
- 今日は `/daily` を開くたびに `logicalDate(new Date())` で導く（`todayPath`）。開いたまま 5 時を越えても、次に `/daily` を開けば次の日になる。今日を返す procedure は無い。Daily の画面の TODAY は画面を作った時に導き、`/daily` を開き直すと作り直される。
- `/notes/:id` は `get` で引いた Note の種類から行き先を決める（`notePagePath`）。Daily は `/daily/:date`、Essay は `/essays/:id` に移る。Repo Note と Scratch は後続の issue が行き先を足すまで「Not found」。
- rail は Daily / Essays / Repo で、⌃1 / ⌃2 / ⌃3 で移る。Library と Settings は持ち込まない。
- NotesShell のサイドバーは既定 400px で、境界のドラッグで 260〜720px、ダブルクリックで 400px に戻る。幅は画面の間で共有し、localStorage の `tania-notes-sidebar-w` に持つ。
- Daily の表示名の書式は `notes/dates.ts` が持つ。サイドバーは今日が `TODAY · TUE 10.6`、ほかは `TUE 10.6`、今年以外は `TUE 2025.10.6`。見出しと競合の通知は年付きの `dayLabelWithYear`（今年なら年を省く）。
- `document.title` は表示名に ` · tania` を付ける（`TUE 10.6 · tania`、`On ledgers · tania`）。Essay の表示名は title で、空なら `Untitled`（`displayName`）。表示名の無い画面（Essay の一覧など）は `tania`。

### Essay の画面

monica の `pages/essays` を移したもの（`pages/essays/`）。

- 一覧（`list.tsx`）はサイドバーの無いカードの grid。カードは writing のバッジ、title と preview の紙のミニチュア、日付（Logical Date を `2026/7/21` で。`notes/dates.ts` の `slashDate`）。並びは `essay.list` のまま（`createdAt` の降順）。
- 一覧の右クリックの menu は `@tania/ui` の `PopoverMenu` で、状態の切り替え（「Mark as finished」か「Move to writing」）と削除を出す。`PopoverMenu` は Escape を見ないので、menu を開いている間だけ一覧の画面が Escape で閉じる。
- 編集（`editor.tsx`）は NotesShell に載せる。サイドバー（`sidebar.tsx`）は `writing N` と `finished N` のタブと、そのタブの Essay の一覧（title、無題なら preview、それも無ければ `Untitled`。`notes/summary.ts` の `summaryTitle`）。タブは開いた Essay の status に合わせ、⌥H / ⌥L で移す。合わせるのは開いた時と status が変わった時だけで、⌥H / ⌥L で移したタブは引き戻さない。
- 一覧の cache の preview は、保存が通るたびに、保存した本文から Backend と同じ `preview` で作り直す（`summary.ts` の `withSavedPreview`。写すのは autosave）。change stream が無いので、写さないと無題の Essay の見出しが `Untitled` のまま残る。一覧を取り直さないのは、打っている途中の title が保存済みの古い値へ戻るため。
- 本文の上に title の入力欄（空なら placeholder の `Untitled`）、status の StatusChip、日付、保存の状態を置く。title は本文と同じ autosave で保存する。title で Enter・↓・Tab・⌃N を押すと本文の先頭へ、本文の先頭で ↑ を押すと title へ移る。
- 状態は StatusChip のクリックか ⌃W で切り替える。次の status は画面が今の status から導き（`support.ts` の `nextEssayStatus`）、`essay.setStatus` に値で渡す。連打は直列にし、2 回目は 1 回目の結果から導く。
- 削除と状態の切り替えは、先に flush して未保存が残れば中止する（`pages/essays/actions.ts`）。⌥Z で戻せるのは Backend に届いた本文までで、状態の切り替えで進んだ版を基準版にすると、競合で残った古い本文が次の保存で外の変更を上書きするため。一覧の右クリックでも、削除は同じく flush してから消す。状態の切り替えは monica どおり flush しない。
- 消した Essay は、autosave の予約（`discard`）と本文の cache（`useForgetNote`）を捨てる。予約が残ると保存が NOT_FOUND で再試行を繰り返し、cache が残ると履歴で戻ったときに消した Essay を cache から開いて、保存だけが失敗し続ける。消す前に flush して未保存が無いのを確かめてあるので、予約を捨てても編集は失われない。
- 状態を切り替えた版は、返った本文と title が送る前の画面と同じとき（status だけが変わった版）に基準版にする。手元の本文はその上に積んでよい。違えば外で書き換わった版で、基準版にすると画面の古い本文が次の保存でその変更を競合なしに上書きする（monica にあった不具合）。そのときは、未保存が無ければ返った Note でエディタを mount し直し、未保存があれば基準版を進めずに、保存の CONFLICT に拾わせる。
- 往復の間に本文か title を書いていたら、返った Note の status だけを取り、本文と title は手元のまま残す（monica は title も返った値で上書きした）。往復の間に別の Note へ移っていたら、返った Note を画面に採用しない。
- 削除は、往復を待つ間の打鍵を保存に予約しない。中止したときは、まだ同じ Essay を開いていれば予約を戻す。別の Note へ移った後に戻すと、その Note の本文を消そうとした Essay に保存してしまう（monica にあった不具合）。消せたときも、往復の間に別の Note へ移っていれば送り先へは移らない。移ったかは prop の id ではなく URL で見る。`navigate` は URL をその場で書き換えるが、prop の id が追いつくのは描画の後なので、その間に削除が返ると移った先から送り先へ移ってしまう。
- `/essays/:id` は Essay 以外の id でも開き、本文の代わりに「Not an essay」を出す。そこでは削除も状態の切り替えもしない。`remove` は Repo Note も消せる種類として受けるので、画面が種類を見ないと Essay の画面から Repo Note を消してしまう（monica にあった不具合）。
- ⌥N と ⌥Z は、往復の間に別の画面へ移っていても、作った Essay と戻した Essay を開く（monica どおり）。開くことがその操作の目的で、画面を移っても autosave は router の上で保存を続けるので、本文は失われない。

| キー | 画面 | すること |
|---|---|---|
| ⌥N | 一覧と編集 | Essay を作って開く。編集から作ると title の入力欄から書き始める |
| ⌥Backspace、⌥Delete | 編集 | 開いている Essay を確認なしで削除する。表示中のタブにあれば次の Essay、無ければ一覧へ replace する |
| ⌥Z | 一覧と編集 | 最後に削除した Essay を戻す。編集では戻した Essay を開く |
| ⌃W | 編集 | status を切り替える |
| ⌥H、⌥L | 編集 | サイドバーのタブを移す。開いている Essay と URL は動かさない |
| ⌥J、⌥K | 編集 | 表示中のタブの中で次と前の Essay を開く |

- キーは window の capture phase の keydown で取るので、⌥Backspace は本文の中でも削除になり、macOS の単語の削除は使えない（monica どおり）。
- 取り消しの stack は `support.ts` の module の変数で、一覧と編集が共有する。そのため一覧の右クリックで消したものも編集の ⌥Z で、編集で消したものも一覧の ⌥Z で戻る。stack は頁を読み込み直すまで残り、Essay の画面を離れている間は ⌥Z が無いので戻せない。戻すときは autosave の `resume` で、削除で止めた保存の再試行を戻す（monica の一覧の ⌥Z は戻さなかった）。

### 保存と競合

- autosave は router より上で 1 つだけ mount し、画面を移っても pending・基準版・競合を持ち続ける。1 秒の debounce で保存し、送信は直列にし、CONFLICT 以外の失敗は 5 秒ごとに再試行する。判断は React に依らない `notes/save-queue.ts` の `SaveQueue` が持ち、`notes/use-autosave.ts` はそれを React の状態と pagehide・beforeunload につなぐ。
- 保存の `expectedUpdatedAt` には、その Note を最後に読んだか書いた `updatedAt`（基準版）を渡す。版は ms で比べる。Daily と Scratch の保存は title を省く。
- CONFLICT は再試行しない。開いている Note はヘッダのバナー（「最新を読み込む」で手元の編集を捨てる）、開いていない Note は左下の常駐の通知に出す。通知の「開く」は `/notes/:id` に移る。
- 「最新を読み込む」は、取り直しが通ってから手元の編集を捨てて採用する（`reloadLatest`）。取り直しが失敗しても TanStack Query は古い cache を data に残して返すので、先に捨てると編集を失って古い版を出す（monica にあった不具合）。取り直しの間に書いた編集があれば、捨てずに競合のまま残す。取り直しの間に別の Note へ移ったら、返った doc を採用しない（Daily の画面は日を移っても同じ hook を使い続けるため）。
- 未保存の編集がある Note を開き直したら（保存中・再試行待ち・競合中に別の日へ移って戻るなど）、cache の本文と title ではなく一番新しい未保存の編集を出す（`noteToOpen` と `SaveQueue.unsavedDraft`）。title も重ねるのは、cache の title で開くと次の打鍵の draft が未保存の title を古い title で置き換えるため。cache の本文を使わないので、cache が基準版より古くても開く。版は基準版のままにする。cache に外の新しい版が入っていても基準版を進めないので、保存は CONFLICT になり、外の変更を上書きしない。未保存の本文は autosave にしか無いので、cache で開くと次の打鍵が保存済みの編集を上書きする（monica にあった不具合）。
- 保存は query の cache を通らない。保存の応答は doc を返さないので、cache は 1 世代古くなる。`notes/note-sync.ts` は、基準版より古い cache を採用しない。外の更新は、未保存が無く、基準版より新しいときだけ採用してエディタを作り直す。
- pagehide で未保存を送る。`CallContext` の `keepalive` を link の `fetch` が init に渡す。keepalive の body の上限（64KB）を超える本文は送れない（monica と同じ）。
- `notes/save-state.ts` は monica の `note-ledger.ts` を改名したもの。tania では Ledger を Backend の部品にだけ使う。

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
- テーマと ambient の切り替えが入るまでは、`apps/web` の `index.html` が `data-theme="dark"` と `data-ambient="none"` を置く。写真を敷く規則は ambient と一緒に足す。

### テスト

- エディタと同じく DOM の環境は入れず、純関数と link を確かめる。
- monica の save-state（14 本）・note-sync（10 本）・summary（4 本）のテストを、contract の形（平らな種類、Date の版）に直して移してある。summary には `summaryTitle` と `withSavedPreview` の 2 本ずつを足してある。
- 保存は `save-queue.test.ts` が、偽の保存と `spyOn` で捕まえた timer で確かめる（debounce、基準版、CONFLICT、再試行、直列、keepalive、title を省くこと、閉じると失われる編集の数え方）。
- Essay の画面は `support.test.ts` と `actions.test.ts` で確かめる。`support.test.ts` は、monica の `pages/essays/support.test.ts`（7 本）を contract の形に直して移したものに、取り消しの stack の 1 本を足してある。`actions.test.ts` は、削除と状態の切り替えの判断を偽の保存の口で確かめる。確かめるのは、flush が返るまで待ってから未保存を見ること、残れば中止すること、往復の間の編集と移動、外で書き換わった版を基準版にしないこと、Essay 以外を消さないこと。
- route は `routes.test.ts`（今日の導出、`/notes/:id` の行き先）、再接続は `reach.test.ts`（1 秒の待ちと確かめの request。timer は `setTimeout` を `spyOn` で捕まえて手で進める）、link は `client.test.ts`（keepalive と届いたかの合図。fetch を `spyOn` で差し替える）。
