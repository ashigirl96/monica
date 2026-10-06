# Note Ledger

`packages/note` の contract と、Note の種類ごとの不変条件、保存、削除と取り消しの規則。決定の理由は ADR-0017・0018・0019 にある。今あるのは Note を 1 件ずつ扱う procedure と本文の中の参照（Note Mention の候補と解決、block の取得）で、一覧、OGP、画像は後続の issue で足す。

## contract（root は `note`）

```
get              { id } → Note
save             { id, content, title?, expectedUpdatedAt } → { updatedAt }   errors: CONFLICT
remove           { id } → void
restore          { id } → Note
daily.open       { date } → Note
daily.dates      → string[]
scratch.open     { repo } → Note
essay.create     → Note
essay.setStatus  { id, status } → Note
repoNote.create  { repo } → Note
noteMention.search   { q } → { id, displayName, preview }[]
noteMention.resolve  { id } → { displayName }
block.get            { id, blockId } → block
```

- `Note` は `kind`（`daily` / `essay` / `repo_note` / `scratch`）の判別 union。どの種類も `id`・`date`・`content`・`createdAt`・`updatedAt` を持ち、Essay は `title` と `status`、Repo Note は `repo` と `title`、Scratch は `repo` を持つ。
- id は `note-N`。table の `id` は integer の AUTOINCREMENT で N を持ち、procedure の入出力で `note-` を付け外しする。削除は soft delete だけで、番号は再利用しない（ADR-0019）。monica から移すときは、N をそのまま入れて `sqlite_sequence` を monica の値にそろえる。
- `content` は ProseMirror の doc の JSON。contract は一番上の `type: "doc"` だけを確かめる。node ごとの形はエディタの schema が決めるもので、server は知らない node を読み飛ばす。
- `date` は Logical Date の `YYYY-MM-DD`。Daily はその Daily の日付、ほかは作った時点の Logical Date で、後から変えない。
- `repo` は `owner/repo` の形だけを確かめ、ghq も GitHub も引かない。書いた時点の綴りで持ち、比べるときは大文字と小文字を区別しない（task の `copy.ts` と同じ）。
- 時刻は他の domain と同じく `z.date()` で出す。
- router は CLI に出さない。meta の型が `cli` を持たないので、`cli: true` を付けると型で落ちる。router は notes の口（ADR-0017）にだけ載せる。
- change stream は持たない。notes の画面は focus のたびに取り直す（ADR-0018）。タブごとに stream を張ると、Chromium の host ごとの接続数の上限（6 本）に当たる。
- `.errors()` で宣言するのは、画面が分岐する保存の `CONFLICT` だけ。ほかは `NOT_FOUND`（無い id と削除した Note）と `BAD_REQUEST`（形の違う入力と、種類に合わない操作）。

contract に置く純関数と定数。server と ui が同じものを読む。

- `logicalDate(at)`: Logical Date。local time の 5 時より前は前の日に数える。server は作るときの `date` に、ui は `/daily` の今日に使う。`today` の procedure は作らない。
- `displayName(note)`: Daily は ISO の日付、Essay と Repo Note は title（空なら `Untitled`）、Scratch は `owner/repo`。
- `IMAGE_URL_PREFIX`: 本文の画像の URL の prefix の `/api/assets/`（ADR-0019）。
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

## createNoteLedger

`createNoteLedger({ db, home })` は `start()` / `stop()` を持つ。今はどちらも何もしない。`home` は画像の置き場所に使う。後続の issue で、Repo の候補のための ghq、`cleanImages()` と画像を配る handler、`stop()` での fetch の打ち切りを足す。router の context は `{ db, noteLedger }`。

note は他の domain を import せず、他の domain からも import されない。前者は `.oxlintrc.json` の override が、後者は package.json が守る。Repo は `owner/repo` の値で持つだけ。

## body

`@tania/note/body` は本文の JSON を読む module で、server と ui の両方が import する。そのため `bun:sqlite`・`drizzle-orm`・schema と server の entry を import しない（`.oxlintrc.json` の override が守る）。node は JSON のまま辿り、prosemirror-model に依らない。今あるのは `preview`・`blockById`・`EMPTY_DOC` で、markdown の変換と画像の参照の列挙は後続の issue で足す。

## テスト

- in-memory の SQLite に note の migration だけを当てる。note は他の domain の table を持たない。
- procedure は `createRouterClient` で呼ぶ。preview は procedure に出ないので、`note` table を SELECT して確かめる。
- 時計は bun:test の `setSystemTime` で止める。止まるのは Date だけで、timer は動く。
- 種類と列の対応と、1 つだけある Note は、table に直に insert して確かめる。
- preview は monica の fixture（`src/body/fixtures/` の `full-doc.json`・`unknown-nodes.json`）で確かめる。fixture は後続の markdown の変換のテストも使う。
