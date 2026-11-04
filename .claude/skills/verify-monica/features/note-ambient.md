# Ambient

ユーザーは notes の画面の右下の pill で、机と紙の下に敷く背景（写真なし・Ink・写真）を選ぶ。⌥; で次へ、⇧⌥; で前へ巡り、選んだものは読み込み直しても残る。

## Sub-features

- `ambient-pick`: pill を押して開いた一覧から背景を選ぶ。
- `ambient-cycle`: ⌥; / ⇧⌥; で一覧を開かずに巡る。
- `ambient-keep`: 選んだ背景が読み込み直しても残る。

## How to get to it (user POV)

- notes の画面（desktop の Note の画面、または `apps/web`）の右下の pill（`button[aria-label^="Ambient:"]`）。押すと `Ambient background` の group に `None`・`Ink`・`Universe`・`Sakura`・`Village`・`Fireworks`・`Shrine` が並ぶ。
- ⌥; と ⇧⌥;。

## Driving it with headless の Backend・Vite・agent-browser

Preconditions:

- [Daily](./note-daily.md) の Preconditions のとおり Backend と Vite を起こし、`agent-browser --session verify-<name> open http://localhost:<Vite の port>/` で開いた。

- **今の背景を読む.** `eval 'document.documentElement.dataset.ambient'` が今の名前（新しい browser の profile では `"universe"`）を返す。
- **選ぶ.** `click 'button[aria-label^="Ambient:"]'` で一覧を開き、`click '[aria-label="Ambient background"] button:nth-child(2)'` で `Ink` を押す。`dataset.ambient` が `"ink"` になり、机と紙が黒に寄る。
- **巡る.** `press 'Alt+;'` を送る。`dataset.ambient` が一覧の次（`Ink` の次は `"universe"`）になる。
- **読み込み直す.** `open` で頁を読み直す。`dataset.ambient` と pill の `aria-label`（`Ambient: <名前>`）が、最後に選んだものになる。
- **証拠.** 選ぶ前と後の `screenshot` を `$E/note-ambient-*.png` に、各 `eval` の出力を `$E/note-ambient.transcript` に残す。

## Gotchas

- 選んだ背景は browser の localStorage にあり、Backend には残らない。RPC など別の経路では読めないので、読み直しは同じ browser で行う。
- 片付けは [Daily](./note-daily.md) の Gotchas のとおり、`agent-browser --session verify-<name> close` と Vite の `kill` を `cleanup.sh` の前に行う。
