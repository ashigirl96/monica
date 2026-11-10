# Repo Note

ユーザーは notes の Repo の画面で、選択の窓（⌃W）から Repo を選んで開き、その Repo の Note を書く。

## Sub-features

- `repo-picker`: ⌃W で選択の窓が開き、窓が開いている間の ⌃W は選ばずに閉じる。
- `repo-chooser`: 前回の Repo が無い `/repos` では、候補が揃うと選択の窓が開いている。

## How to get to it (user POV)

- notes の画面の Repo（⌃3）。
- URL は `/repos`（前回の Repo があればそこへ移る）と `/repos/<owner>/<name>`。`github.com/` は付けない。
- Repo の画面の左の欄の「Study」の欄は [Study](./study.md) の `study-repo-panel` で確かめる。

## Driving it with headless の Backend・Vite・agent-browser

- **Preconditions.** 候補は ghq の `github.com` の下の checkout から取る。scratchpad に `<dir>/github.com/acme/alpha/.git` のような空の directory を作り、`launch.sh <name> MONICA_BROWSER_PORT=<port> GHQ_ROOT=<dir>` で起こす。渡し忘れると、ユーザーの本物の checkout が候補に並ぶ。ほかは [Daily](./note-daily.md) と同じ。
- **開く.** `open http://localhost:<Vite の port>/repos/acme/alpha`。
- **窓.** `press Control+w` のたびに、`eval "(() => !!document.querySelector('input[placeholder^=\"Switch\"]'))()"` が true と false を繰り返す。`/repos` の窓の placeholder は `Open repo…`。
- **前回の Repo を消す.** `/repos` を見るときは `eval "(() => { localStorage.clear(); history.pushState(null, '', '/repos'); dispatchEvent(new PopStateEvent('popstate')) })()"`。
- **証拠.** 窓を開いた時の `screenshot` を `$E/note-repo-*.png` に、⌃W ごとの窓の有無を `$E/note-repo.transcript` に残す。

## Gotchas

- 候補が 0 件か読み込み中の `/repos` では、窓は描かれず、⌃W は何も起こさない。
