---
name: install-app
description: 手元の source を release の Monica として build し、`/Applications` に入れ直して起動する。install-app・入れ直し・再起動を頼まれたときに使う。
---

release の Monica はユーザーが毎日使う app で、この skill を呼んだこと自体が入れ替えの了承になる。

1. `bun run install-app` を Bash の `run_in_background` で走らせ、出力は scratchpad の file に向ける。script が build → Monica の終了 → 入れ替え → 起動 → Backend の `/health` 待ちまでを行う（`docs/packages/dev-loop.md` の「release build と install」）。終了から起動までの間、Monica の Tab で会話を読んでいるユーザーには返事が見えないので、終わるまで質問を挟まない。
2. 終了コード 0 と、最後の行の `Started: Backend pid <pid>` で完了とする。落ちたら出力の末尾を読んで原因をユーザーに伝える。
3. 変更が Backend の起動時に書くファイル（`~/.monica/bin/claude` など）に届くなら、そのファイルを読んで変更が入ったことを確かめる。
4. ユーザーに伝える: 入れたのは今の working tree（未 commit の変更を含む）の build であること。すでに Tab で動いている claude や shell は古いまま動き続け、起動し直したものから新しい wrapper と env を使うこと。
