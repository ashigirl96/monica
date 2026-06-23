# テストダブルと本番実装の乖離を見つける

## いつ使うか

テストが通っているのに本番でバグが起きる場合、テストダブル（FakeRepos, mock 等）と本番実装（SQL store 等）のロジックが乖離している可能性がある。

## 実例: FakeRepos vs SQL store の pending_stop 設定

### Step 1: fix コミットのテスト側を確認

```bash
git show <commit> -- crates/monica-core/src/usecases/tests.rs
```

テストが `record_hook` レベル（統合テスト）か `record_task_run_observation` レベル（単体テスト）かで、カバー範囲が変わる。

### Step 2: テストダブルの実装を読む

FakeRepos は Stop を直接的に検出していた:

```rust
// FakeRepos (テストダブル)
if observation.event_name == Some("Stop")
    && observation.status.is_none()      // ← 直接チェック
    && run.active_subagents > 0
{
    run.pending_stop = true;
}
```

### Step 3: 本番実装と比較

SQL store は `observation.status` から間接的に計算:

```rust
// SQL store (本番)
let generic_wait = match (observation.status, ...) {
    (Some(_), Some(_)) => ...,
    _ => false,  // status=None → false
};
let subagent_guard = generic_wait && ...;  // → false
```

### Step 4: 乖離の原因を特定

FakeRepos: `observation.status.is_none()` を直接条件にしている → 動く
SQL store: `observation.status` から `generic_wait` を間接計算 → `None` だと `false` → 動かない

**同じ概念を異なるロジックで実装しているため、片方だけ壊れる。**

### Step 5: 回帰テストを追加

本番パスを再現するテストを SQL store のテストに追加する。今回は `status: None` で Stop を渡すテスト。

```rust
// 本番で起きるパスを再現: status=None (protected で消された)
record_observation(&mut db, &run.id, "Stop", None, None);
let s = snapshot(&db);
assert!(s.pending_stop);  // ← fix 前は失敗する
```

## 乖離を見つけるためのチェックリスト

1. **テストダブルと本番実装の分岐条件が同じか?** — 同じ入力で同じ出力を返すか、条件の書き方が違うだけで等価か
2. **テストが本番と同じ入力を渡しているか?** — テストが `status: Some(WaitingForUser)` を渡していても、本番では `status: None` が来る場合がある
3. **テストダブルにハードコードされた条件がないか?** — `event_name == Some("Stop")` のような文字列リテラル比較は、本番側で等価な条件が正しく計算されているか要確認
4. **上流の加工を経た値 vs 生の値** — テストが加工前の値を直接渡している場合、上流の加工（今回は `transition_is_protected`）の影響を再現していない
