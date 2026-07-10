---
name: verify
description: Monica の GUI 変更を実機で検証する手順。just dev をバックグラウンド起動し、tauri-mcp-server (tauri-plugin-mcp-bridge, port 9223) で webview を駆動して観察する。
---

# Monica GUI 検証レシピ

## 起動と接続

1. `just dev` をバックグラウンドで起動（dev-cli + ptyd ビルド込み。初回コンパイルは数分）
2. `until nc -z localhost 9223; do sleep 2; done` で mcp-bridge の起動を待つ
3. `driver_session` (tauri-mcp-server) を `start` — 以後 `webview_*` ツールが使える

## 罠

- **prod と dev の 2 プロセスが並走しうる**。`/Applications/Monica.app` 常駐 + `target/debug/monica-desktop`。
  ps で pid を特定し、AppleScript の frontmost 化は `first process whose unix id is <pid>` で dev を狙う。
- **ウィンドウが occluded だと `document.visibilityState === "hidden"` になり CSS アニメーション
  （tailwindcss-animate の `animate-in`）が 0% で止まる** → オーバーレイ類が computed opacity 0 になり
  スクリーンショットに写らない。機能は生きている。視覚確認だけなら対象要素の `style.animation = 'none'`
  を一時注入すれば写る。
- **`webview_keyboard` の press はグローバルショートカット（window keydown リスナー）に届かないことがある**。
  `webview_execute_js` で `window.dispatchEvent(new KeyboardEvent('keydown', { key, metaKey, bubbles: true, cancelable: true }))`
  を合成するのが確実。contenteditable ガード（`isEditable`）を通したい場合は対象要素に dispatch する。
- **`webview_interact` の text ストラテジ click が sidebar 行に効かないことがある** →
  `webview_execute_js` で要素を探して `pointerdown/pointerup` + `click()` を dispatch する。
- ProseMirror への入力は `document.execCommand('insertText', false, text)`（要素 focus 後）が手軽。
  ただし input rules（`# ` → 見出し等）はまとめて insert すると発火しない。

## データ確認

- dev DB は `~/monica/dev/db/monica.db`。`sqlite3` で直接 SELECT して永続化を検証する。
- 検証で書いたデータは終了時に UPDATE/DELETE で戻す。

## 後始末

- `driver_session` を stop → dev プロセスと `target/debug/monica-ptyd` を kill（`just kill-dev` も可）。
