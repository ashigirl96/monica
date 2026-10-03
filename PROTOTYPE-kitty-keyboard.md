# PROTOTYPE: xterm.js 6.1 beta の kitty keyboard protocol

#60 の Q1 (b) を確かめるための捨てる branch。main には入れない。

## 問い

xterm.js を 6.1 beta に上げて `vtExtensions.kittyKeyboard` を有効にすれば、`TERM_PROGRAM=WezTerm` のまま、Tab の claude に Ctrl+V で画像が貼れ、Shift+Enter が改行になるか。

## 変えたもの

- `@xterm/xterm` 6.1.0-beta.304、`@xterm/addon-fit` 0.12.0-beta.301、`@xterm/addon-unicode11` 0.10.0-beta.301、`@xterm/addon-webgl` 0.20.0-beta.300
- Terminal に `vtExtensions: { kittyKeyboard: true }`
- `registerParsers` の `CSI ? u` への偽の返答と、`CSI > u`・`CSI < u` の握りつぶしを外した
- Shift+Enter の特別扱い（`\x1b[13;2u` を常に送る）を外した
- 観測用に `window.__proto`（`terms`・`sent`・`csi`）を足した

## 動かし方

1. `TANIA_HOME=${TMPDIR%/}/tania-pk bun run desktop`
2. tauri-mcp で繋ぎ、`window.__proto.terms[<tabId>].textarea` に `keydown` を dispatch する（`keyCode` は `Object.defineProperty` で足す）
3. 画像は `osascript -e 'set the clipboard to (read (POSIX file "<png>") as «class PNGf»)'` で clipboard に置く

## 結果（claude 2.1.288、2026-10-04）

| 場面 | キー | xterm が送ったもの | 結果 |
|---|---|---|---|
| shell（zsh） | Shift+Enter | `\r` | legacy のまま。余計な文字なし |
| shell（zsh） | Ctrl+V | `\x16` | legacy のまま |
| claude | 起動 | 受信 `CSI <u`・`CSI >5u`・`CSI ?u`、返答 `CSI ?5u` | xterm が flag を持ち、正しく答えた |
| claude | Shift+Enter | `\x1b[13;2u` | 改行された |
| claude | Ctrl+V（画像を clipboard に置いて） | `\x1b[118;5u` | `[Image #1]` が貼られた |
| claude | Ctrl+C | `\x1b[99;5u` | 入力が消えた |
| claude を抜けた後の shell | Shift+Enter・Ctrl+V | `\r`・`\x16` | claude の pop で legacy に戻った |

tania が使っている非公開の `_core.coreService.onUserInput` は 6.1 beta にも残っていた。
