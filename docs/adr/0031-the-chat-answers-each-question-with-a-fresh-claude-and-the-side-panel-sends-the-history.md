---
status: accepted
---

# Chat の答えは質問ごとに起こす claude が作り、前の問答は side panel が送る

Chrome Extension の Chat の質問には、Backend が質問ごとに Agent SDK の `query()` を 1 回起こして答え、答え終えたら閉じる。前の問答は side panel が持って質問と一緒に送り、Backend はそれを prompt の文字として渡す。Agent SDK には、session の jsonl を書かずに前の turn を会話として渡す口が無い（#262）。Chat ごとに claude を持ち続けて streaming input で turn を重ねる形では、Backend が Chat の終わりを知る必要がある。`sidePanel.onClosed` と side panel の `pagehide` からの keepalive fetch は大半の閉じ方で届くが、service worker が止まっている間のブラウザの終了、logout の SIGTERM、crash では届かない（Brave 1.97 の実機）。届かなければ、1 つ 280MB の claude が Backend の終わりまで残る。それを時限で拾うと、Chat の終わりに「しばらく質問しない」が加わる。side panel は描画のために履歴をすでに持っているので、Backend は Chat を知らず、Chat の状態を持たない形にした。

## Considered Options

- **Chat ごとに claude を 1 つ持ち続ける**: 2 問目からは最初の文字まで 0.5〜0.76 秒で、前の turn が prompt cache に乗る。代わりに、side panel を開いた window の数だけ claude が質問の無い間も残り、上の終わりを知る経路と時限が要る。
- **一時 directory に jsonl を書き、質問ごとに resume する**（`sessionStore` か `CLAUDE_CONFIG_DIR`）: 前の turn を会話として渡せる。代わりに、`sessionStore` は `persistSession: false` と組めず、走っている間は jsonl と keychain から写した認証が disk に出る。ページの本文を disk に残さないという ADR-0030 の決定に反する。

## Consequences

- Chat は、新しい Chat を始めるか side panel を閉じると終わる。Backend が居なくなっても終わらない。Backend が居ない間の質問は失敗し、desktop が戻れば同じ Chat で続けて訊ける。side panel は購読を張らない（ADR-0028）ので、質問の合間に Backend が再起動しても side panel は知らず、知る必要も無い。
- 毎回 claude を起こすと最初の文字まで 1.0〜1.6 秒かかる。そこで Backend は spare（`startup()`）を全体で 1 つまで持つ。spare は side panel を開いた時に呼ぶ procedure と答えを 1 つ終えた時に起こし、5 分使われなければ閉じる。spare から答えると 0.63 秒になる。
- 毎回、前の問答を送り直す。前の問答は prompt cache に乗りにくく、plan の login では使用量に効く。前のページの中身を含めるかと長さの上限は「model に渡すページの情報」で決める。
- Backend は送られた履歴を検めない。ブラウザの口を呼べる他の拡張は、ADR-0028 で守る相手の外にしている。
- 同時に走らせる claude は 4 つまでにし、超えた分は断る。token の無い口から 1 つ 280MB の process を起こせるため、Mac のメモリを食い潰されないようにする。
- side panel を閉じて回答の stream が abort したら、その claude を止める。Backend の終了では、起こした claude をすべて SIGKILL する。SDK の `close()` に任せると、turn の途中の子が数秒残って使用量を使い続ける（#257）。
- 置き場所は新しい domain package `packages/chat`（`@monica/chat`）とし、entry は contract・server・ui の 3 つ。table は持たないが、空の journal は持つ。router はブラウザの口にだけ `{ note, chat }` で載せ、change stream は持たない。server の部品は、記録を持たないので Ledger とは呼ばず、`ChatAgent`（`createChatAgent()`）と呼ぶ。
