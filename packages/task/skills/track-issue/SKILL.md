---
name: track-issue
description: >-
  GitHub issue を作り、tania の Task として track する（tania 用。monica の
  track-issue とは別物）。「tania で track して」「issue を作って tania に載せて」
  のように、issue を tania の Task にしたいと示されたときに使う。既にある issue を
  tania で track するだけのときも使う。
---

GitHub に issue を作り、`tania task track` で tania の Task にする。既にある issue を track するだけなら、1 を飛ばしてその issue の URL を 2 に渡す。

## 1. issue を作る

対象の repo に issue を立てる。title と body はユーザーの依頼から組み立て、repo が曖昧なときだけ確かめる。

```bash
gh issue create --repo <owner/repo> --title "<title>" --body "<body>"
```

親の issue が決まっている子 issue は、`gh sub-issue create --parent` で作る（拡張 `yahsan2/gh-sub-issue`）。作ると同時に GitHub の Sub-issues で親に繋がり、track がその親を写す。body に `Part of #N` と書くだけでは繋がらない。

```bash
gh sub-issue create --parent <親の番号か URL> --repo <owner/repo> --title "<title>" --body "<body>"
```

`gh sub-issue create` は `gh issue create` と同じ flag を受けない。

- `--body-file` は無い。長い body は `BODY=$(cat body.md)` で変数に入れ、`--body "$BODY"` で渡す。
- `--assignee @me` は黙って無視される。user 名を直に書くか、作った後に `gh issue edit <番号> --add-assignee <user>` で足す。

既にある issue を後から親に繋ぐのは `gh sub-issue add <親> <子>`。親と子を両方作るときは親 → 子の順に作り、親の body のチェックリストに子の番号を書き足す。

どちらの command も、作った issue の URL を stdout に出す。その URL を 2 に渡す。

## 2. track する

```bash
tania task track <issue の URL>
```

- ref は issue の URL か `owner/repo#n` で渡す。`#n` だけの ref は受けない。
- 子 issue も 1 本ずつ track する。
- track は Issue とその parent・Blocker を GitHub から写し終えてから返る。track の後に `tania task sync` は打たない。

成功すると `tracked <owner/repo#n> <title>` と出る。`already tracked <ref>` なら既に Task がある。その Task が closed なら reopen を案内されるが、reopen は再挑戦を始める操作なので、ユーザーに確かめてから打つ。

失敗したら stderr の 1 行目（`CODE: message`）で読む。

| 1 行目 | 意味 |
|---|---|
| `NOT_FOUND: GitHub has no issue <ref>` | GitHub がその issue を返さない。番号の打ち間違いか、gh のアカウントや SSO で読めない |
| `BAD_GATEWAY: could not sync from GitHub: …` | GitHub に届かないか、`gh auth token` が失敗した |
| `BAD_REQUEST: "<ref>" is not owner/repo#n …` | ref の形が違う |
| `BACKEND_NOT_RUNNING: …`（exit 2） | tania の desktop が起動していない |

どれも track せずにエラーをそのまま報告する。issue は作れたが track に失敗したときは、作った issue の URL も添える。

## 3. 確かめて報告する

```bash
tania task list
```

track した ref の行が出ていれば Task になっている。この一覧は open な Task だけを出すので、closed のまま残した Task は `tania task list --closed` で見る。ref、title、issue の URL（子 issue なら親も）をユーザーに報告する。

track の後に「実装しましょうか」と誘わない。次にどんな issue を作るかを相談する調子で締め、実装は「実装して」「tackle して」と言われてから始める。
