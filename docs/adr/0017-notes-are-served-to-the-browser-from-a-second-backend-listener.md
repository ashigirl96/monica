---
status: accepted
---

# notes は Backend の 2 つ目の口からブラウザに配り、token の代わりに Host と Sec-Fetch-Site で守る

monica の notes は、tania ではブラウザで書く（map #112）。ブラウザは `backend.json` を読めない。また port 0 の口は起動のたびに port が変わるので、ブックマークも、origin（port を含む）ごとに分かれる localStorage も保てない。そこで Backend に固定 port の 2 つ目の口を立て、notes の router と画像と SPA だけを載せる。release の URL は `http://tania.localhost:19380`。この口は token を持たない。DNS rebinding は Host の完全一致で止め、CSRF は GET 以外の request に `Sec-Fetch-Site: same-origin` を求めて止める。同じ Mac の他のユーザーからは守らない。単一ユーザーの Mac で使うもので、monica も守っていなかった。workbench・task・job の procedure はこの口に載せない。`openTab` の `input` は shell にそのまま打鍵されるので、token の無い口に載せると任意のコマンドを実行できてしまうため。ADR-0007 の port 0 と token の口は、webview と CLI のために今のまま残す。

## Considered Options

- **今の口に相乗りする**: port が起動ごとに変わるので、ブラウザが口を見つけられない。
- **口を 1 本の固定 port にまとめ、notes の procedure だけ token 無しで通す**: ADR-0007 の port 0 をやめることになり、dev の home ごとの port の衝突が Backend の起動失敗になる。1 つの口の中で、token が要る procedure と要らない procedure を分ける照合も要る。
- **永続の秘密を cookie に入れる**: 他のユーザーからも守れる。ただし最初に開く経路が desktop に縛られ、cookie が消えるたびに desktop から開き直すことになる。cookie は port で分かれないので、dev と release で cookie の名前も分ける必要がある。起動ごとの token を cookie に入れると、Backend が再起動するたびに開き直しになる。
- **Host の照合だけ（monica の形）**: これで止まるのは DNS rebinding だけ。Brave の Local Network Access は public な site からの fetch と iframe を止めるが、top-level の form POST は loopback まで届く。oRPC 1.15.4 は multipart の POST を、input を指定された形で実行する。そのため、どこかの site を開いただけで note を書き換えられる。
- **oRPC の SimpleCsrfProtectionHandlerPlugin**（`x-csrf-token` header）: 同じものを止められる。しかし loopback と `*.localhost` 宛ての request には Chromium も Safari 16.4 以降も `Sec-Fetch-Site` を付けるので、こちらなら client に plugin を足さずに済む。
- **SPA を Tauri の resources に置く**: headless で起こした Backend が SPA を配れない。
- **Bun の HTML import で Backend が SPA を bundle する**: Tailwind の plugin が CLI の `bun build --compile` では効かない。bundler も Vite と Bun の 2 つになる。

## Consequences

- 照合で通す `Sec-Fetch-Site` の値は `same-origin` だけにする。`same-site` も通すと、`localhost:3000` で動く別の app からの request も通ってしまう（site は port を見ないため）。oRPC の event iterator も POST なので、同じ照合に乗る。
- Host の照合では `tania.localhost:<port>`・`localhost:<port>`・`127.0.0.1:<port>` を通す。保存された本文とブックマークに残る正の URL は `tania.localhost`。
- bind 先は `127.0.0.1` と `::1` の両方。Chromium と macOS は `tania.localhost` を `::1` から先に引くので、他の process が `::1` 側を握っているとブラウザはそちらに繋がる。両方で bind すれば、この衝突を EADDRINUSE で検出できる。
- 口の port は Shell が env で Backend に渡す。release は 19380、dev は `scripts/dev-instance.ts` が home から決める（既定の home は 19381、ほかは hash で散らす）。env が無ければ Backend は口を立てない。こうすれば、headless で起こした dev の Backend が release の port を取ることはない。
- bind に失敗したら、Backend は notes の口なしで起動を続け、stderr に 1 行出す。notes のために Workbench を止めない。
- SPA は `apps/web` に置く。Vite で build した `dist` を、Backend の binary に `--asset` で同梱する。dev では `apps/web` の Vite の dev server（HMR）が、同じ home の Backend の notes の口へ proxy する。その Backend が居なくても、release の口には倒さない。
- desktop を閉じている間は何も listen していないので、ブラウザ自身の接続エラーの頁が出る（ADR-0007 の「不在は正常系」）。Backend の再起動中は、SPA が「tania に再接続中…」を出し、autosave が 5 秒ごとに再試行する。未保存の編集が残っている間は、`beforeunload` でタブを閉じる前に確認を出す。
- Chromium の HTTP/1.1 の接続は host:port ごとに 6 本までで、ブラウザは h2c を使わない。そのため、タブごとに長く張る stream があると、タブが増えたところで読み込みが止まる。
