---
status: accepted
---

# Chrome Extension は Native Messaging の host から Backend の port と chat の token を受け取り、token の口の chat を呼ぶ

ADR-0028 では、side panel の Chat が固定 port のブラウザの口を token 無しで呼んだ。release の 19380 を別の process が先に握ると、Backend は bind の失敗を記録して口なしで起き、side panel は Current Page の HTML・PDF・スクリーンショットと履歴をその process に送ってしまう（PR #283）。固定 port のままでは、Chrome Extension は送り先が本物の Backend かを確かめられない。そこで送り先を ADR-0007 の token の口（port 0）にし、その port と token を Native Messaging の host から受け取る。host manifest の `allowed_origins` には monica の Chrome Extension の ID だけを書くので、他の拡張は host を起こせない。port と token は 0700 の home の中の 0600 の `backend.json` にあるので、他のユーザーの process は送り先を変えられない。

渡すのは全権の token ではなく、Backend が起動ごとに作る chat だけの token にする。token の口は、この token の request を chat の router だけを持つ handler に通し、workbench・task・job には 401 を返す。side panel で script が動いても、shell に打鍵する `workbench.openTab` には届かない（ADR-0017 の「token の無い口に、shell や command に届く procedure を載せない」と同じ守り）。ADR-0028 のうち、Chat がブラウザの口を token 無しで呼ぶという決定を、この ADR が置き換える。ブラウザの口は notes の画面のために今のまま残す。

## Considered Options

- **ブラウザの口のまま、送り先が本物かを確かめる**（challenge-response、pairing）: 事前に共有した秘密を Chrome Extension に届ける経路が要る。HTTP は平文で、port を握った偽物が裏で本物に中継できるので、request と response ごとに MAC を付けないと中身は守れない。
- **全権の token を渡す**: Chrome Extension から Run を起こせるようになるが、side panel の script から shell に届く。
- **Native Messaging を transport にする**（KeePassXC と Bitwarden の形）: 奪える TCP の port が無い。ただし host から browser への 1 通が 1MiB までで、答えの event stream を自前で枠に分け、port ごとに host の process が 1 つ要る。
- **release と dev の ID を 1 つの manifest に並べる**: manifest の path は 1 つなので、release の `.app` の CLI と dev の worktree の CLI を分けられない。

## Consequences

- host は同梱の CLI（`Contents/MacOS/monica`）。Chromium が第 1 引数に渡す `chrome-extension://<id>/` で host として振る舞い、`MONICA_HOME`（無ければ `~/.monica`）の `backend.json` の port と chat の token を 1 通で返す。Backend が居なければ `{ "error": "not-running" }` を返す。全権の token は返さない。
- side panel は RPC を呼ぶたびに `sendNativeMessage` で問い合わせ、結果を覚えない。Backend が起き直すと port と token が変わるため。host が無い・Backend が居ない・古い chat の token で 401 を受けた、のどれも「desktop に届かない」に数え、帯を出して 5 秒おきと focus の確かめ直しに乗せる。
- Brave は user-data-dir に依らず、`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` の manifest だけを読む。
  - release の manifest（host 名 `com.ashigirl96.monica`、release の ID）は、release の Shell が起動のたびに書く。path は Shell の隣の `monica`。debug の Shell は書かない。
  - dev の manifest（host 名 `com.ashigirl96.monica_dev`、dev の ID）は、`bun run extension` が起動のたびに同じ場所に書く。path は worktree に依らない `~/.monica-dev/native-host` の sh で、どの worktree が書いても中身は同じになる。sh は dev の Brave から継いだ `MONICA_REPO` の worktree の CLI を起こし、CLI は同じく継いだ `MONICA_HOME` の Backend を返す。
  - Chrome Extension は vite の mode で host 名を build に焼く。
- 同じ実の HOME で起こした Brave は、profile が違っても同じ manifest を読む。agent が release の build を読み込ませた Brave も、ユーザーの release の Backend の port と chat の token を受け取れる。
- 守らないもの: 同じユーザーの process（manifest も `backend.json` も書ける。ADR-0007 と同じ）。Backend が SIGKILL で死んで `backend.json` が残り、その pid が使い回され、その port を別の process が握った場合。
- Chrome Extension の permission に `nativeMessaging` が増える。unpacked で読み込むので、警告も、reload での無効化も起きない。
- token の口の body の上限を chat の `MAX_ASK_BODY_BYTES`（50MB）にする。workbench・task・job の input はどれもこれより小さい。ブラウザの口は chat を降ろしたので上限を外し、note の画像の 20MB は Note Ledger が見る。
