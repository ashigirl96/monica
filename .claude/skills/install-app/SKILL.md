---
name: install-app
description: 手元の source を release の Monica として build し、`/Applications` に入れ直して起動する。Monica の app・Backend・Chrome Extension に届く修正を終えたら、聞かずに使う。install-app・入れ直し・再起動を頼まれたときも使う。
---

release の Monica はユーザーが毎日使う app で、ユーザーは修正が終わるたびに入れ直すことを了承している。

- 修正を終えた（テストと実機の確認が通った）ら、聞かずに入れ直す。docs・skill・テストだけの変更では入れない。
- テストが落ちている間や、修正の途中では入れない。

1. `bun run install-app` を Bash の `run_in_background` で走らせ、出力は scratchpad の file に向ける。script が build → Monica の終了 → 入れ替え → 起動 → Backend の `/health` 待ちまでを行う（`scripts/install-app.ts`）。終了から起動までの間、Monica の Tab で会話を読んでいるユーザーには返事が見えないので、終わるまで質問を挟まない。
2. 終了コード 0 と、最後の行の `Started: Backend pid <pid>` で完了とする。落ちたら出力の末尾を読んで原因をユーザーに伝える。
3. 変更が Backend の起動時に書くファイル（`~/.monica/bin/claude`・`~/.monica/tutors/` など）に届くなら、そのファイルを読んで変更が入ったことを確かめる。
4. ユーザーに伝える: 入れたのは今の working tree（未 commit の変更を含む）の build であること。すでに Tab で動いている claude や shell は古いまま動き続け、起動し直したものから新しい wrapper と env を使うこと。Chrome Extension に届く変更なら、`brave://extensions` で読み込み直すこと。
