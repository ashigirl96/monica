# 多層コードの机上トレース

## いつ使うか

データ上のギャップ（「ここで pending_stop=1 になるはずなのに 0」）が見つかったら、コードを各レイヤーごとに追跡して、値がどこで消えるかを特定する。

## 実例: record_hook → SQL store の二重ガード問題

### Step 1: 呼び出し元から入力を特定

```
record_hook.rs:
  transition_for_event("Stop") → Some(AWAITING_PROMPT)
  transition_is_protected(Running, ..., subagent_in_flight=true) → true
  transition = None (protected だから)
  observation.status = transition.map(|t| t.status) = None  ← ここで情報が消える
```

各関数の引数と戻り値を、実データから特定した値で埋めて追跡する。

### Step 2: 受け取り側で入力がどう使われるか追跡

```
SQL store の record_task_run_observation:
  generic_wait = match (observation.status=None, ...) → false
  subagent_guard = false && ... = false
  ?12 = false → SQL の pending_stop CASE に到達しない
```

### Step 3: SQL パラメータを全て列挙

SQL を使っている場合、各 `?N` パラメータの値を列挙してから CASE 式を評価する。

```
?1  = status = NULL
?10 = generic_wait = false
?11 = terminal_verdict = false
?12 = subagent_guard = false  ← これが問題
?15 = subagent_dec = false
?16 = event_has_running_subagents = false
```

### Step 4: CASE 式を手動評価

```sql
status = CASE
  WHEN {protected} THEN status    -- false (全サブ条件が false)
  WHEN ?15 AND ... THEN '...'     -- false (?15=false)
  ELSE COALESCE(NULL, status) END -- → 'running' のまま
```

## コツ

- **advisory check と atomic guard の二重構造に注意**: Rust 側で advisory に判定した結果が、SQL 側の atomic guard に渡すパラメータを変えてしまう場合がある。今回はまさにこれ
- **SQLite の UPDATE 内の列参照は pre-update 値**: 同一 UPDATE 文内の複数の SET 句は全て更新前の値を参照する。`active_subagents <= 1` は decrement 前の値で評価される
- **呼び出し元で加工された値を追跡する**: `observation.status` が `transition.map(...)` で作られている場合、`transition` が `None` になる条件を遡る
