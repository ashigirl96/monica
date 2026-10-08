---
status: accepted
---

# Note の本文は旧 Monica の形のまま保存する

Note の本文（ProseMirror の doc の JSON）は、旧 Monica で保存していた形のまま monica に持ち込む。node の type 名と attrs、Note の id の `note-N`、画像の相対の `src: /api/assets/<uuid>.<ext>` のどれも変えない（map #112）。本文は一度保存すると書き換えにくい。noteMention と syncedBlock は id を、image は path を本文の中に持ち、editor・markdown の変換・画像の GC がその文字列を読む。形を変えないので、移行で本文を書き換えるのは link の URL（origin と、Repo の path の `/projects/` から `/repos/` への変更）だけになる。

## Considered Options

- **id を workbench の形（prefix 付きの UUIDv7）にする**: 移行で noteMention 12・syncedBlock 1・link の中の id をすべて書き換えることになる。URL と markdown の `[[…]]` も長くなる。
- **id を task・job の形（integer の連番）にする**: 同じく本文の `note-N` をすべて書き換え、markdown の `[[7]]` だけでは何への参照か読めなくなる。
- **画像の path を monica に寄せる（`/images/` など）**: 移行で src 15 個を書き換え、editor の `ASSET_URL_PREFIX`、markdown の取り込みの判定、GC の走査の prefix を変えることになる。`/assets/` は Vite の build が使うので選べない。
- **image を asset id で持つ**: editor の image node、markdown の変換、GC の走査に加え、取り込みに失敗して外部 URL のまま残る画像の扱いも変えることになる。

## Consequences

- monica で `/api/` を使うのは画像の配信だけになる。notes の口（ADR-0017）は `/api/assets/*` を素の GET の route で配る。oRPC の RPCHandler は File を必ず multipart に包むので、`<img src>` が読む生のバイト列を返せない。
- 画像の URL の prefix は `@monica/note/contract` の定数 1 つにし、server（GC と取り込み）と ui（editor と markdown）が同じものを読む。
- GC が参照として数えるのは、相対の `/api/assets/` で始まる文字列だけ。絶対 URL で書いた画像の参照は数えない（旧 Monica と同じ）。
- id の番号は再利用しない。Note の削除は soft delete だけなので、autoincrement で足りる（旧 Monica の `note_counter` は持ち込まない）。
