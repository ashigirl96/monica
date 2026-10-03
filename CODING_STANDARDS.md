# Coding standards

review で差分に当てる規則。どれも判断が要るもので、決定の本文と理由は括弧の中の文書にある。機械で判定できる規則は lint・型・テストに置き、ここには書かない。

## domain と package

- 1 つの概念は `packages/<domain>` の 1 箇所で定義する。層ごとの写し型、DTO、port と adapter を作らない（ADR-0002）。
- apps は packages を組み立てるだけで、ロジックを持たない（ADR-0002）。
- domain をまたぐ書き込みは、相手の domain の method を通す。読み出しは相手の schema を直接 SELECT してよい（`docs/packages.md` の「domain をまたぐ規則」）。
- 他の domain から呼ばれる書き込みは、第 1 引数に transaction を取る同期の method にする。ptyd や fs への副作用は別の async method にし、呼び手が commit の後に呼ぶ（`docs/packages.md` の「server entry の形」）。
- DB を開いて書くのは Backend だけ。CLI・Shell・webview は procedure を呼ぶ（ADR-0003、ADR-0011）。
- Shell（`apps/desktop/src-tauri`）に置くのは、Tauri プロセスにしか無いもの（窓と webview の event、app の名義、AppKit）に触る処理と、端末の byte だけ。fs と process の spawn で済む処理は Backend の procedure にする（ADR-0001）。

## テスト

- DB は fake にせず、in-memory の SQLite に migration を当てる。外から見える振る舞いは `createRouterClient` を通して確かめる（`docs/packages.md` の「テスト」）。

## 語

- 型・関数・画面の語は `GLOSSARY.md` の定義に合わせる。_Avoid_ に挙がった語は使わない。

## コメント

- `~/.claude/CLAUDE.md` の「コードコメント」に従う。
