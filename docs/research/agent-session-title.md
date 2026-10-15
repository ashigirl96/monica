# Agent Session Transcript の `ai-title` を測った結果

通知の body に Agent Session の title を足した #188（2026-10-07）で、手元の Agent Session Transcript を読んで確かめた事実。測った Claude Code の版は記録に無い。

- 手元の Agent Session Transcript 87 件では、最後の `ai-title` の行は末尾から 33 KiB 以内にあった。workbench が末尾 64 KiB だけを読むのはこのため。
- 行は `{"type":"ai-title","aiTitle":…}` の形の、空白を詰めた JSON で書かれる。会話の本文に同じ文字列が出ても、本文の中では `"` が escape されるので、`"type":"ai-title"` を含む行として探せば本文には当たらない。
- `ai-title` は Claude Code の文書化されていない形式で、短い会話には付かない。
- `aiTitle` は、Claude Code が Tab の title（OSC 0/2）に出す会話の名前と同じ。
