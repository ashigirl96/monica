---
name: attach-task
description: >-
  いま自分が動いている monica の Workbench の Tab を、track 済みの monica の Task に
  attach する（monica 用。旧 Monica の attach-task とは別物）。「この会話を
  owner/repo#12 に attach して」「この Tab を monica の Task に繋いで」のように、
  今の会話を monica の Task に結びつけたいと示されたときに使う。Task を新しく作るのは
  track-issue で、attach は track 済みの Task にだけ繋ぐ。
---

`monica task attach` で、自分が動いている Tab を Task の Bench に移す。Tab の claude（自分）はその Task の Run になり、自分の状態がその Task の表示状態に出る。Task に Bench が無ければ、Repo の checkout（`$(ghq root)/github.com/<owner>/<repo>`）を cwd にした Bench をその場で作る。Tab の shell の cwd は変わらない。

GUI では、Tab のメニューの「Attach to Task…」か、Tab を Bench へ drag して同じことができる。

## 1. まだ Task に属していないか確かめる

```bash
monica task current --format json
```

- 成功したら、この Tab は既に Task に属している。attach せず、`ref` と `title` を報告して終える。`source` が `run` なら自分がその Task の Run で、`bench` なら Tab がその Task の Bench にある。
- `NOT_FOUND: Terminal Session … runs no Run of a Task, and its Tab is not in a Bench` なら、まだどの Task にも属していない。2 へ進む。
- `BAD_REQUEST: not in a Tab of the Workbench …` か `monica: command not found` なら、monica の Workbench の Tab の外（別の端末や旧 Monica の tab）で動いている。attach できないと報告して終える。
- `BACKEND_NOT_RUNNING: …`（exit 2）なら、monica の desktop が起動していない。そう報告して終える。

## 2. ref を決める

CLI が受ける ref は `owner/repo#n` か issue の URL だけ。

- 引数がこの形なら、そのまま使う。
- `#12` や番号だけなら、track 済みの Task の ref から番号の合うものを引く。repo が 1 つに決まらなければ、候補を見せてユーザーに選んでもらう。
- 引数が無ければ、track 済みの Task を見せて、どれに attach するかをユーザーに尋ねる。推測で繋がない。

```bash
monica task list --format json
```

この一覧は open な Task だけを出す。`tasks[].ref` に無ければ、closed な Task も引く。

```bash
monica task list --closed --format json
```

closed な Task にあれば、reopen は再挑戦を始める操作なので、勝手に打たずユーザーに確かめる。どちらにも無い issue は track されていない。attach は Task を作らないので、勝手に track せず、先に track が要ると報告する。

## 3. attach する

```bash
monica task attach <ref>
```

成功すると次のように出る。1 行目は Bench をその場で作ったときだけ出る。

```text
opened the Bench of acme/app#12 in place
this Tab is in the Bench of acme/app#12 Ship it
claude 6253bdb0-… is now a Run of acme/app#12
```

最後の行が `no claude runs in this Tab; …` なら、Tab は Bench に移ったが、自分は monica に観測されていない（自分の hook が届いていない）。4 の `source: bench` と同じく、そう報告する。

断られたら stderr の 1 行目（`CODE: message`）で読む。

| 1 行目 | 意味と対処 |
|---|---|
| `CONFLICT: claude <id> in this Tab is a Run of <ref>, and stays with it until it ends` | 自分は既に別の Task の Run で、この claude（会話）が終わるまでその Task に属する。この会話のままでは繋ぎ替えられないと報告する |
| `BAD_REQUEST: <ref> is closed …` | closed な Task。reopen は再挑戦を始める操作なので、勝手に打たずユーザーに確かめる |
| `NOT_FOUND: <ref> is not tracked` | track されていない。先に track が要ると報告する |
| `BAD_REQUEST: Terminal Session <id> is in no Tab …` か `BAD_REQUEST: not in a Tab of the Workbench …` | Workbench の Tab の外で動いている。attach できないと報告する |
| `BAD_REQUEST: <ref> has no Bench and its Repo is not cloned at <path> …` | Bench が無く、Repo の checkout も無い。attach は clone しない。`ghq get <owner/repo>` してよいかをユーザーに確かめ、clone してから attach し直す |
| `BAD_REQUEST: could not find the checkout of <ref>: …` | Bench が無く、`ghq root` が引けない（ghq が無いか失敗した）。そう報告する |
| `CONFLICT: <ref> is being closed` | その Task は close の途中。終わるのを待ってから状況を確かめる |
| `BACKEND_NOT_RUNNING: …`（exit 2） | monica の desktop が起動していない |

## 4. 確かめて報告する

```bash
monica task current --format json
```

`source` が `run` で `ref` が attach した Task なら、自分はその Task の Run になっている。ref と title を報告し、Bench をその場で作ったならそれも伝える。`source` が `bench` なら Tab は Bench に移ったが、自分は Run として観測されていない（自分の hook が monica に届いていない）ので、そう報告する。

attach しても自分の env は変わらない。どの Task にいるかを後で知りたくなったら `monica task current` で引く。Run を外す command は無く、Task を close しても外れない。この claude（会話）が終わるまでその Task の Run のまま。
