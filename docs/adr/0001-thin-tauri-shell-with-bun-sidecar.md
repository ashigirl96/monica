---
status: accepted
---

# Tauri は domain を知らない配管だけに絞り、backend は Bun の sidecar で動かす

monica では Task・DB・CLI まで Rust で書いた結果、人間が読めない領域が大半を占めた。tania では Rust に残すのを Tauri の shell 本体と、ptyd（PTY daemon）・terminal protocol・その client と daemon・log を担う terminal の 5 crate だけにし、いずれも Task を知らない固定の配管とする。Task を含むすべての業務ロジックと DB は TypeScript の backend が持ち、desktop はそれを Bun でコンパイルした sidecar として起動して HTTP/oRPC で呼ぶ。

## Considered Options

- **Electron**: main process が hono と DB と ptyd 中継をすべて TS で持てるので言語が 1 つになる。配布サイズが約 200MB になること、ランタイムが Node になって CLI も Node に揃える必要があること、Workbench の Tauri command 経路を書き直すことを理由に見送った。「言語を 1 つにしたい」がこれらより重くなったら再検討する。
- **ブラウザのみ**: cmd+W / cmd+T を握れず multi-window も制御できないので端末 app の殻にはならない。閲覧系の画面には将来使える。

## Consequences

- 言語は 2 つ残るが、Rust 側は読む必要のない配管に限る。Rust にドメインロジックや DB を置かない。
- Shell に置くのは、Tauri プロセスにしか無いもの（窓と webview の event、app の名義、AppKit）に触る処理と、Backend の再起動で途切れてはいけない端末の byte だけ。通知（ADR-0013）と画像のクリップボードはこれに当たり、worktree の判定やエディタを開く処理のように fs と process の spawn で済むものは Backend に置く（#39）。
- sidecar の起動・終了・port の受け渡しは Tauri が担う。
- ランタイムは Bun に統一し、DB は `bun:sqlite` で開く。monica のバイナリ最小化方針は Tauri shell にだけ適用し、sidecar には適用しない。
