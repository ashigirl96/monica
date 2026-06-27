# ビルドバージョンと git の突き合わせ

## いつ使うか

「fix は入っているのになぜ再現する？」という疑問が出たとき。コードの修正が実際に動いているバイナリに反映されているかを確認する。

## 実例: Monica.app のバイナリと fix コミット

### Step 1: バイナリのタイムスタンプを取得

```bash
ls -la /Applications/Monica.app/Contents/MacOS/
# Jun 21 00:25 monica-desktop
```

### Step 2: fix コミットの日時を取得

```bash
git log --oneline --format="%ci %s" -- crates/ | head -5
# 2026-06-20 23:18:10 +0900 fix: SubagentStop 後に run が running のまま固着するバグを修正
```

### Step 3: 比較

- バイナリ: Jun 21 00:25
- fix コミット: Jun 20 23:18
- **fix はビルドに含まれている** → バージョン問題ではなく fix 自体にバグがある

### Step 4: fix 以降の変更も確認

```bash
git log --oneline --format="%ci %s" --after="2026-06-21T00:25:00+09:00" -- crates/
```

fix 後にロジックを変えるリファクタが入っていないか確認する。

## バージョン情報が埋め込まれていない場合の代替手段

- `build.rs` に `env!("CARGO_PKG_VERSION")` や `vergen` があるか確認
- `Info.plist` の `CFBundleVersion` を確認（ただし固定値の場合は役に立たない）
- バイナリの mtime と git log の日時を突き合わせる（上記の方法）
- `stat -f "%Sm" <binary>` でファイル変更日時を取得

## コツ

- **タイムゾーンに注意**: git log は `+0900` で表示されるが、`ls -la` はローカル時刻。同じタイムゾーンに揃えて比較する
- **ビルドに含まれている＝動いている、ではない**: ビルドに含まれていても、fix 自体にバグがある可能性を忘れない（今回のケース）
