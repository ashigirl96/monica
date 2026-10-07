# Note Ledger

`packages/note` の contract と、Note の種類ごとの不変条件、保存、削除と取り消し、本文の中の参照、画像、OGP の規則。決定の理由は ADR-0017・0018・0019 にある。今あるのは Note を 1 件ずつ扱う procedure、Repo の Note の一覧と Repo の候補、本文の中の参照（Note Mention の候補と解決、block の取得）、画像、OGP で、Essay の一覧は後続の issue で足す。

## contract（root は `note`）

```
get              { id } → Note
save             { id, content, title?, expectedUpdatedAt } → { updatedAt }   errors: CONFLICT
remove           { id } → void
restore          { id } → Note
daily.open       { date } → Note
daily.dates      → string[]
repo.candidates  → string[]
scratch.open     { repo } → Note
essay.create     → Note
essay.setStatus  { id, status } → Note
repoNote.create  { repo } → Note
repoNote.list    { repo, after? } → { notes, next }
noteMention.search   { q } → { id, displayName, preview }[]
noteMention.resolve  { id } → { displayName }
block.get            { id, blockId } → block
image.upload         { file } → { url }
image.import         { url } → { url }
linkMetadata         { url } → { title, description, image, favicon, siteName }
```

- `Note` は `kind`（`daily` / `essay` / `repo_note` / `scratch`）の判別 union。どの種類も `id`・`date`・`content`・`createdAt`・`updatedAt` を持ち、Essay は `title` と `status`、Repo Note は `repo` と `title`、Scratch は `repo` を持つ。
- id は `note-N`。table の `id` は integer の AUTOINCREMENT で N を持ち、procedure の入出力で `note-` を付け外しする。削除は soft delete だけで、番号は再利用しない（ADR-0019）。monica から移すときは、N をそのまま入れて `sqlite_sequence` を monica の値にそろえる。
- `content` は ProseMirror の doc の JSON。contract は一番上の `type: "doc"` だけを確かめる。node ごとの形はエディタの schema が決めるもので、server は知らない node を読み飛ばす。
- `date` は Logical Date の `YYYY-MM-DD`。Daily はその Daily の日付、ほかは作った時点の Logical Date で、後から変えない。
- `repo` は `owner/repo` の形だけを確かめ、ghq も GitHub も引かない。書いた時点の綴りで持ち、比べるときは大文字と小文字を区別しない（task の `copy.ts` と同じ）。
- 時刻は他の domain と同じく `z.date()` で出す。
- router は CLI に出さない。meta の型が `cli` を持たないので、`cli: true` を付けると型で落ちる。router は notes の口（ADR-0017）にだけ載せる。
- change stream は持たない。notes の画面は focus のたびに取り直す（ADR-0018）。タブごとに stream を張ると、Chromium の host ごとの接続数の上限（6 本）に当たる。
- `.errors()` で宣言するのは、画面が分岐する保存の `CONFLICT` だけ。ほかは `NOT_FOUND`（無い id と削除した Note）と `BAD_REQUEST`（形の違う入力と、種類に合わない操作）。画像は oRPC の標準の code を使う（「画像」の節）。エディタは失敗の理由で分岐しない。

contract に置く純関数と定数。server と ui が同じものを読む。

- `logicalDate(at)`: Logical Date。local time の 5 時より前は前の日に数える。server は作るときの `date` に、ui は `/daily` の今日に使う。`today` の procedure は作らない。
- `displayName(note)`: Daily は ISO の日付、Essay と Repo Note は title（空なら `Untitled`）、Scratch は `owner/repo`。
- `IMAGE_URL_PREFIX`: 本文の画像の URL の prefix の `/api/assets/`（ADR-0019）。body の画像の参照の列挙と markdown の取り込みも読むので、定義は body に置いて contract が re-export する。body が contract を import すると、contract の先の schema と drizzle-orm まで読むため。
- `NOTES_HOSTNAMES`: notes の口が答える host 名（`tania.localhost`・`localhost`・`127.0.0.1`）。notes の口の Host の照合と、エディタの内部リンクの判定が読む。Host の照合は DNS rebinding を防ぐ許可の一覧なので、名前を足すとその口に届く経路も増える。

## 種類ごとの不変条件

Note は `note` table に 1 件 1 行で持つ。種類と列の対応を CHECK で、1 つだけある Note を部分 unique index で縛るので、table に直に insert しても破れない。

| 種類 | title | status | repo | 削除 | 1 つだけ |
|---|---|---|---|---|---|
| Daily | 無い | 無い | 無い | できない | Logical Date ごと |
| Essay | 有る | `writing` / `finished` | 無い | できる | |
| Repo Note | 有る | 無い | 有る | できる | |
| Scratch | 無い | 無い | 有る | できない | Repo ごと（`lower(repo)`） |

- 種類は後から変えない。変える procedure は無い。
- `daily.open` と `scratch.open` は get-or-create で、無ければ作る。Daily は未来の日付も作れる。Scratch は最初に作った時の綴りを持ち続ける。
- `daily.dates` は Daily のある Logical Date を新しい順に返す。Daily は Logical Date ごとに 1 つなので、monica の `daily-counts` の件数は持たない。Daily の画面のサイドバーとカレンダーが読む。
- `essay.create` は title が空で `writing` の Essay を、`repoNote.create` は title が空の Repo Note を作る。どちらも呼ぶたびに新しい Note になる。
- 作った Note の本文は、エディタの schema を満たす最小の doc（`@tania/note/body` の `EMPTY_DOC`）。
- `essay.setStatus` は toggle ではなく値を受ける。次に送る値は画面が導く。今と同じ値なら何も書かず、`updatedAt` も進めない。Essay 以外は `BAD_REQUEST`。

## 保存

- `save` は `expectedUpdatedAt`（必須）を、今の `updatedAt` と比べる。違えば `CONFLICT` で断り、何も書かない。monica にあった、省いたときの無条件の上書きは無い。
- `title` を受けるのは Essay と Repo Note だけ。省けば今の title のまま。Daily と Scratch に渡すと `BAD_REQUEST`。
- 保存のたびに preview を作り直す。preview は最初の空でない block の text を 200 文字まで切ったもので、一覧が本文の代わりに返す。文字は見た目の 1 文字（grapheme）で数え、つないだ絵文字を途中で切らない。Note Mention・link mention・hard break・画像・bookmark・Synced Block は text に数えず、表のセルは空白で区切る。作るのは `@tania/note/body` の `preview`。
- `updatedAt` を進めるのは、本文と title の保存と Essay の状態の変更だけ。削除と取り消しは進めない。進めるときは前の値より 1 ms 以上後にする。同じ ms のうちに 2 度書くと版が区別できず、古い版からの保存が通るため。

## Repo の Note の一覧と Repo の候補

- `repoNote.list` は Repo の Repo Note（Scratch と削除した Note は除く）を、`date` の新しい順、同じ日は id の大きい順に 1 頁 100 件ずつ返す。Repo は大文字と小文字を区別せずに比べる。
- 頁は `(date, id)` の keyset で切る。`after` に前の頁の `next`（その頁の最後の行の `date` と `id`）を渡すと、それより後ろの行を返す。最後の頁の `next` は null。monica の offset は、読み込みの途中で Note が増えると同じ行を次の頁にも出した。keyset なら、途中で作った Note は 1 頁目の前に入り、読み込み済みの頁の後ろには混ざらない。
- 行は content ではなく `id`・`date`・`title`・`preview`・`updatedAt` を持つ。`preview` は本文を一度も保存していない Note では null。
- `repo.candidates` は picker に出す Repo の並び。Note のある Repo を、その Repo の Note を最後に更新した順に先に並べ、残りの ghq の checkout を後に並べる。
  - 削除した Note は数えない。削除した Note しか無い Repo は、ghq の checkout でなければ出ない。
  - 綴りが大文字と小文字だけ違う Repo は 1 つにまとめ、一番最近に更新した Note の綴りで出す。ghq の checkout も、Note のある Repo と大文字と小文字を区別せずに重ねない。
  - ghq の checkout は `ghq list` の行のうち `github.com/` の下だけ（ADR-0004）で、`owner/repo` の形でないものは除く。並びは `ghq list` の順。
  - ghq が失敗したら Note のある Repo だけを返す。5 秒で返らなければ ghq を kill し、その終わりを待たずに Note のある Repo だけを返す。ghq の子が stdout を握って残ると、ghq を kill しても `ghq list` の出力が読み終わらないため。
  - ghq の checkout だけでは、改名した Repo と checkout を消した Repo の Note に辿り着けない。Note は書いた時点の `owner/repo` を持ち続け、改名に追従しないため。

## 削除と取り消し

- `remove` は Essay と Repo Note に `deletedAt` を付ける（soft delete）。Daily と Scratch は `BAD_REQUEST` で断る（monica は画面だけが断っていた）。削除した Note と無い id は `NOT_FOUND`。
- 削除した Note は、`get`・`save`・`essay.setStatus` で `NOT_FOUND` になる。
- `restore` は `deletedAt` を外して Note を返す。削除していない Note はそのまま返す。無い id は `NOT_FOUND`。
- 削除した Note の一覧（ゴミ箱）は無い。取り消せるのは、削除した画面にいる間だけ（`GLOSSARY.md` の Note）。

## 本文の中の参照

Note Mention と Synced Block が引く procedure。画面での扱いは `docs/packages/note-ui.md` の「Note Mention と Synced Block」にある。

- `noteMention.search` は、title・表示名・preview・Repo のどれかが q を含む Note を、更新の新しい順に 20 件返す。大文字と小文字を区別せず、q の前後の空白は落とす。空の q は最近更新した 20 件になる。削除した Note は出さず、開いている Note も外さない（monica どおり）。
- 表示名は列に無い導出値なので、SQL では絞らず、削除していない行を新しい順に読んで `displayName` で絞る。monica は列の LIKE で絞った後に表示名で絞り直していたので、title が空の Essay を「Untitled」で引けなかった。Essay と Repo Note の `date` は名前に含まないので、日付では引けない。
- `noteMention.resolve` は Note の今の表示名を返す。削除した Note と無い id は `NOT_FOUND`。
- `block.get` は、`attrs.id` が blockId の blockContainer を、入れ子の block ごと保存された JSON のまま返す（`@tania/note/body` の `blockById`）。Note が無いか削除してあるとき、その block が無いときは `NOT_FOUND`。Synced Block の中の Synced Block を深さ 8 まで展開する処理は持たない。monica で使っていたのは CLI の `note show --expand` だけだった。
- `noteMention.resolve` と `block.get` は id を形を問わずに受け、`note-N` の形でなければ `NOT_FOUND` にする。本文の attrs の id には、貼った URL から緩く抜き出したもの（ui の `internalNoteId`）もある。`BAD_REQUEST` で断ると、画面は「Deleted note」も「Original block was deleted」も出せない。

## 画像

`GLOSSARY.md` の画像。Note とは別に file で置き、本文の image node の `src` が相対の URL で参照する。Note と画像の対応表は持たない。処理は `src/image.ts` に置く。

### 置き場所

- `$TANIA_HOME/note-images/<uuid>.<ext>`。uuid は小文字の UUID v4、ext は `png`・`jpg`・`gif`・`webp`。GC が消してよい範囲と、口が配ってよい範囲が名前の形で分かる。
- 本文に入る URL は `/api/assets/<uuid>.<ext>`（`IMAGE_URL_PREFIX` に file 名を付けたもの、相対）。

### upload と取り込み

- `image.upload` は `z.file()` を受ける。RPCLink は File を含む input を multipart で送る。
- `image.import` は外部の URL を受け、Backend が fetch して upload と同じく置く。http と https だけを受け（ほかは input の検証で `BAD_REQUEST`）、行き先の host は制限しない。外の site からの呼び出しは notes の口の same-origin の照合で止まる。
- どちらも置いた画像の URL を返す。
- 上限は 20MB。超えれば `PAYLOAD_TOO_LARGE`。upload は File の中身を写す前に大きさを見る。取り込みは Content-Length を信じず、読みながら数えて、超えた所で読むのをやめて接続を切る。
- 形式は先頭のバイト列（magic bytes）だけで決め、Content-Type と file 名は見ない。png・jpg・gif・webp 以外は `UNSUPPORTED_MEDIA_TYPE`。SVG は本文の中で script を動かせるので断る。
- バイト列は再 encode せずに書く。動く GIF も動いたまま残る。
- 取り込みは 10 秒で打ち切る（`GATEWAY_TIMEOUT`）。応答が始まらないときも、body の途中で止まったときも同じ。2xx 以外の応答と、届かない相手は `BAD_GATEWAY`。monica は status を見ず、404 の応答の画像も置いていた。
- Note Ledger の `stop()` は、走っている取り込みの fetch を打ち切る。

### 配信

- `NoteLedger.serveImage(name)` が `/api/assets/<name>` の GET への応答を返す。apps/backend が notes の口の素の GET の route に載せる（`docs/packages.md` の「notes の口」）。
- `name` は置くときの名前の形（小文字の UUID と 4 つの拡張子）で厳密に照合してから path にする。合わなければ、file が無いときと同じ 404。`..` や `/` を含む名前も、大文字の UUID も、置き場所に別の名前で在る file も配らない。
- `cache-control: public, max-age=31536000, immutable`。同じ名前の画像は中身が変わらない。content-type は拡張子から Bun が付ける。

### GC

- `NoteLedger.cleanImages()` は、どの Note の本文にも参照されず、置いてから 48 時間を過ぎた画像を消す。system の Job `note.image-cleanup`（24 時間ごと）が呼ぶ。Job Ledger は start のときにすぐ 1 回走らせるが、48 時間の猶予があるので、貼ったばかりでまだ保存していない画像は消えない。
- 参照として数えるのは、全 Note（削除したものを含む）の本文の、相対の `/api/assets/` で始まる文字列の値。node の型を問わない（`@tania/note/body` の `imageReferences`）。削除した Note は取り消せるので、その本文の参照も数える。`http://…/api/assets/…` のような絶対 URL は数えない（ADR-0019）。
- 消すのは画像の file 名の形をしたものだけ。置いた時刻は mtime で、mtime が読めないものと未来のものは残す。
- 外から画像を置くとき（monica からの移行、#134）は、mtime を置いた時刻にする。`cp -p` や `rsync -a` で元の mtime を残すと、参照する本文がまだ入っていない間に Backend が起きたとき、起動直後の掃除が消す。
- 同期の fs で走らせる。参照を読んでから消すまでの間に await があると、`save` が古い画像の参照を書き戻せるため（task の setup の log の掃除と同じ）。
- 消せなかった画像があれば、残りを消してから reject する。Job Execution が失敗になり、次の回がやり直す。本文の JSON が読めなければ、何も消さずに reject する。

## OGP

`linkMetadata` は URL の頁を fetch し、Bun の HTMLRewriter で OGP を読む。エディタが URL を貼ったときの「Paste as」で、「Mention」が作る `linkMention` と「Bookmark」が作る `bookmark` に使う。ブラウザは他の origin の HTML を読めないので、server の procedure にしている。

- 受けるのは http と https の URL だけで、ほかは contract が `BAD_REQUEST` で断る。Bun の fetch は `file:` と `data:` も読むため。`file:` への redirect は Bun の fetch が断る。
- 10 秒で打ち切り、`GATEWAY_TIMEOUT` で失敗する。時間は header を待つ間と body を読む間の両方に掛かる。
- HTML は 1MB まで読み、そこで読みやめて残りの転送を止め、読んだ分を解析する。OGP は head にあるので、読みやめても取りこぼさない。
- 2xx 以外の応答と、届かなかった request は `BAD_GATEWAY` で失敗する。redirect は fetch の既定のまま追う。
- `Content-Type` が無いか、大文字小文字を区別せずに `html` を含むときだけ body を読む。ほかは body を読まず、項目はどれも無いものとして favicon だけを `/favicon.ico` にする。
- 行き先の host は制限しない。localhost の URL を貼るのは正当な使い方で、外の site からの呼び出しは notes の口の same-origin の照合で止まるため。
- cache は持たない。取った値は、貼った時点で本文の attrs に入る。
- 画面は失敗の種類で分岐しないので、`.errors()` で宣言しない。

取る項目は monica と同じ。値は前後の空白を落とし、空なら無いものとして次の候補を見る。

| 項目 | 取り方 |
|---|---|
| `title` | `og:title`、無ければ文書の中で最初の `<title>` の text（head より前に svg の `<title>` があればそれになる） |
| `description` | `og:description`、無ければ `meta name=description` |
| `image` | `og:image` を頁の URL で絶対 URL にしたもの |
| `siteName` | `og:site_name` |
| `favicon` | `rel` の token に `icon`（大文字小文字を区別しない）を含み、`href` が空でなく絶対 URL に解ける最初の `link` の `href`、無ければ `/favicon.ico` |

- meta は `property` と `name` の両方を見て、同じ key は最初のものを使う。key は大文字小文字を区別する（monica と同じ）。
- 相対 URL は redirect を追った後の URL を基準に解く。

monica から変えたのは次の 4 つ。

- 2xx 以外を失敗にする。monica は 404 の頁の title も拾っていた。
- charset に従って TextDecoder で decode してから解析する。charset は `Content-Type` の `charset`、無ければ先頭 1024 byte の `<meta charset>` か `<meta http-equiv="Content-Type">` の `charset`、どちらも無ければ UTF-8 で決める。TextDecoder が知らない名前も UTF-8 で読む。HTMLRewriter は byte 列を UTF-8 として読むので、先に decode しないと Shift_JIS の頁が化ける。
- entity を decode する。HTMLRewriter は属性値と text の entity を decode せずに渡すので、`entities` の `decodeHTMLAttribute`（属性値）と `decodeHTML`（`<title>` の text）を当てる。属性値の規則（`&copy=` のように `=` や英数字が続く `;` の無い参照は decode しない）は text と違う。
- User-Agent に `tania` を送る。monica は送っていなかった。

このほか、`Content-Type` の大文字小文字を区別しないことと、空か絶対 URL に解けない `href` の icon を飛ばすことも monica と違う。

## createNoteLedger

`createNoteLedger({ db, home, ghq? })` は `start()` / `stop()`・`repoCandidates()`・`cleanImages()`・`serveImage(name)` を持つ。`start()` は何もせず、`stop()` は走っている画像の取り込みと OGP の fetch を打ち切る。`home` は画像の置き場所に使う。`ghq` は `list(signal)` を持ち、省けば `ghq list` を `env: process.env` で spawn する。`signal` で打ち切ると ghq を kill する。task の `Ghq`（`packages/task/src/prepare.ts`）は import しない。`repoCandidates()` は `repo.candidates` の中身で、router の handler が呼ぶ。router の context は `{ db, noteLedger }`。procedure が使う画像の置き場所と打ち切りの signal は、型に出さずに `internals(noteLedger)` で引く（task と job と同じ形）。

`@tania/note/server` の `systemJobs(noteLedger)` が system の Job の並び（`note.image-cleanup`）を出す。note は job を import しないので、task と同じく `createJobLedger` の `systemJobs` と同じ構造の素のオブジェクトを返す。

note は他の domain を import せず、他の domain からも import されない。前者は `.oxlintrc.json` の override が、後者は package.json が守る。Repo は `owner/repo` の値で持つだけ。

## body

`@tania/note/body` は本文の JSON を読む module で、server と ui の両方が import する。そのため `bun:sqlite`・`drizzle-orm`・schema と server の entry を import しない（直接の import は `.oxlintrc.json` の override が、contract などを経た import は `src/body/entry.test.ts` が守る）。node は JSON のまま辿り、prosemirror-model に依らない。今あるのは `preview`・`blockById`・`EMPTY_DOC`、画像の参照を列挙する `imageReferences`、本文と markdown の変換（`toMarkdown`・`fromMarkdown`）。

### markdown の変換

monica の Rust（`note_markdown.rs`・`note_markdown_import.rs`）を TypeScript に写したもの。ui が copy と paste で手元で呼ぶ（`docs/packages/note-ui.md` の「markdown の copy と paste」）。procedure は作らない。contract は oRPC の型の正本なので、変換を混ぜずに body に置く。

- `toMarkdown(doc, noteName?)` は失敗しない。知らない node と mark は中の text だけを拾い、型の違う field は無いものとして読む。doc でない値はその text を書く。monica は型の違う field が 1 つでもあると文書全体を plain text に落としていたが、node を JSON のまま辿るので持ち込まない。
- Note Mention は `[[note-N|表示名]]` で書く。表示名は呼び手が `noteName` で渡し、null か空なら `[[note-N]]`。
- link mention と bookmark は `[title](href)`、underline は `<u>…</u>`、callout は `> [!kind]` で書く。Synced Block は参照の形（`![[note-N#^block]]`、block ごとに 1 行）のまま書き、中身を展開しない。
- `fromMarkdown(markdown)` は失敗せず、どの構文にも当たらない行は paragraph にする。block の id は振らない（貼り付けの経路が振る）。`[title](href)` は link の mark になり、`![[note]]`・`![[note#^blk]]` は Synced Block になる。画像は src が `IMAGE_URL_PREFIX` か http(s) の行だけを image にする。
- 往復しないもの: toggle は quote に、list 以外の block の子は平らになり、`[[note-N|表示名]]` の表示名は捨てる。見出しの中の改行は、続く行を別の block として読む。
- 字下げは 64 段で打ち切り、それより深い行は兄弟にする。1 段ごとに再帰するため。
- 持ち込まないもの: Synced Block の展開（`FULL_DOC_EXPANDED_MD`）、循環の打ち切り、全文検索の plain text。どれも CLI の `note show --expand` と全文検索のためのもの。

## テスト

- in-memory の SQLite に note の migration だけを当てる。note は他の domain の table を持たない。
- procedure は `createRouterClient` で呼ぶ。preview は procedure に出ないので、`note` table を SELECT して確かめる。
- 時計は bun:test の `setSystemTime` で止める。止まるのは Date だけで、timer は動く。
- ghq は `createNoteLedger` に偽の `list` を渡して差し替える。CI の ts job に ghq は無い。5 秒の打ち切りは、`setTimeout` を `spyOn` して 5000ms の callback を捕まえ、手で呼ぶ。偽の `list` は終わらない promise を返し、ghq の終わりを待たずに返ることを確かめる。
- 種類と列の対応と、1 つだけある Note は、table に直に insert して確かめる。
- preview と markdown の変換は monica の fixture（`src/body/fixtures/` の `full-doc.json`・`unknown-nodes.json`）で確かめる。
- markdown の変換のテストは、monica の import の 33 本と export の 11 本から、展開・循環・plain text のものを除いて写してある。`full-doc.json` の書き出しは monica の golden（`FULL_DOC_MD`）と一字ずつ比べる。
- monica の Rust を写した関数は、monica の `crates/monica-domain` を path 依存で読む scratch の crate に、テストの入力と部品を乱択で組み合わせた入力を流し、TS の出力と突き合わせる。空白の判定（Rust の `trim` は Unicode の White_Space）や `str::lines` の `\r` のような境界の振る舞いは、golden と写したテストだけでは写し漏れを拾えないため。
- 画像は `image.test.ts` が、一時 directory の home で確かめる。取り込みの相手は Bun.serve の fake で、終わらない body、始まらない応答、途中で止まる body を作る。10 秒の打ち切りは、task の sync と同じく `importImage` に短い timeout を渡して確かめる。GC の 48 時間は時計を止めず、画像の mtime を `utimesSync` で過去と未来に置く。
- 画像の GET と multipart の輸送は、apps/backend の `notes-listener.test.ts` が RPCLink で upload してから GET して確かめる。
- OGP の行き先は `src/fake-site.ts` の fake の site に差し替える。fake は Bun.serve で path ごとに status・header・body を返し、届いた request の path と User-Agent を記録し、header の保留（`hold()`）、body の後に送り続けるか止まったままでいること、client が body を読みやめたこと（`cancelled`）を記録する。task の `fake-github.ts` と同じ形。
- 10 秒の打ち切りは、`AbortSignal.timeout` を `spyOn` で差し替え、渡された ms を確かめてから手で abort する。header を待つ間と body の途中で止まった間の両方で確かめる。`stop()` も同じ 2 つで確かめる。
- 1MB で転送を止めたことは、fake に cancel が 200ms 以内に届くことで見る。読みやめたまま捨てた body も GC が 1 秒ほどで cancel するので、待つ時間を長くすると cancel を呼ばなくても通る。
- Shift_JIS の頁は、iconv で作った byte 列を fake に返させて確かめる。
