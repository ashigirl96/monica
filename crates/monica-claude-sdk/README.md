# monica-claude-sdk

Monica の Workbench で動いている対話型 Claude Code セッションを Rust から運転するための SDK（親 issue: #306）。公式 SDK やワンショット CLI は使わず、ptyd の Unix ドメインソケットに直結して PTY へ入力を注入する。desktop app は経由しない。

MVP1 (#307) のスコープは **送信のみ**: 既存の claude Tab にテキストを届けて Enter で送信できることの仮説検証。セッション作成・応答読み取り・入力可否判定はスコープ外（MVP2, 4, 5）。

## 使い方

```sh
# prod (~/monica) の Tab へ送る
cargo run -p monica-claude-sdk --example send_text -- --tab <tab-id> "<text>"

# dev インスタンス (~/monica/dev) の Tab へ送る
MONICA_HOME=$HOME/monica/dev cargo run -p monica-claude-sdk --example send_text -- --tab <tab-id> "<text>"
```

tab id は DB から引ける:

```sh
sqlite3 ~/monica/dev/db/monica.db "SELECT id, title, cwd FROM terminal_tabs ORDER BY created_at DESC LIMIT 10"
```

example は tab の最新 terminal session を解決し、ptyd に生存確認（`list`）をしてから bracketed paste + Enter を書き込む。

## 送信方式の設計メモ

送信 = 2 段階の PTY write:

1. `ESC[200~ <text> ESC[201~`（bracketed paste。テキスト中の改行は端末エミュレータの貼り付けと同じく `\r` に正規化。テキストに紛れ込んだ `ESC[200~` / `ESC[201~` は除去する — 埋め込み終端で paste が途中終了し残りが生のキー入力になる paste injection を防ぐため。断片が再結合しないよう収束するまで繰り返し除去）
2. `SUBMIT_DELAY`（150ms）待ってから `\r`（Enter）

paste と Enter を分けて遅延を挟むのは、Claude Code (Ink) が paste を非同期に入力欄へ反映するため。同一チャンク末尾の Enter は反映前に消費されうる。Warp の Claude Code 連携も同じ 2 段戦略（`DelayedEnter`、50ms）を採っており、「各 write が agent 側で別々の stdin read として処理されるようにするため」と説明している。

Warp との相違: Warp は Claude Code には bracketed paste を使わず生バイトを送る（bracketed paste は Codex 用戦略）。この SDK が bracketed paste を使うのは、①複数行テキストの改行が Enter として解釈され途中送信されるのを Ink の paste 検知ヒューリスティックに頼らず確実に防ぐため、②`!` / `&` の mode-switch prefix がリテラル文字扱いになり、SDK からの送信で意図せず bash mode 等へ切り替わらないため。

`Write` は notification（応答なし）なので、死んだ session に書いても daemon は黙って捨てる。送信前の `list` による生存確認が唯一の検証点。

## 観察記録（MVP1 動作確認）

2026-07-05、prod インスタンスの実 claude Tab（対話中のセッション）に対して example で送信し、session JSONL（`~/.claude/projects/<slug>/<session-id>.jsonl`）への追記で確認した。

- 単純テキスト: 送信したテキストがバイト一致で user message として記録され、claude が即座に応答を開始した
- 複数行 + 日本語: 空行を含む 4 行の日本語テキストが、改行構造ごと完全に保持されて 1 メッセージで届いた（paste 内で `\r` に正規化した改行は TUI 側で `\n` として復元される）

### claude が応答生成中に送った場合の挙動

失われない。Claude Code が注入メッセージを queue し、**現在の応答が完了した後に次の user turn として処理**する。JSONL 上は「応答完了 → 注入した user message → その応答」の順で記録され、化け・欠落・現在応答への混入は観察されなかった。

### SUBMIT_DELAY (150ms) の要否・十分性

150ms で 3 シナリオとも初回から送信成功（アイドル時・生成中とも）。より短い値は未検証。Warp は同じ 2 段戦略を 50ms で出荷しているため、短縮の余地はあるが MVP では 150ms を維持する。
