# イベント時系列の再構成とカウンタ追跡

## いつ使うか

状態遷移が期待通りに動いていない場合、イベントを時系列で並べ直し、各ステップでの内部状態を手動でトレースする。

## 実例: SubagentStart/Stop のカウンタ追跡

### Step 1: 関連イベントを時系列で抽出

まずイベントの種類を集計して全体像を把握し、次に時系列で展開する。

```bash
# 種類別の件数
sqlite3 ~/monica/db/monica.db "
  SELECT json_extract(payload_json, '$.hook_event_name') as evt, COUNT(*)
  FROM events WHERE task_run_id = 'run-133'
  GROUP BY evt ORDER BY COUNT(*) DESC;"

# 時系列展開（状態遷移に関係するイベントのみ）
sqlite3 ~/monica/db/monica.db "
  SELECT id,
    json_extract(payload_json, '$.hook_event_name') as evt,
    json_extract(payload_json, '$.background_tasks') as bg,
    created_at
  FROM events
  WHERE task_run_id = 'run-133'
    AND json_extract(payload_json, '$.hook_event_name') IN (
      'SessionStart','UserPromptSubmit','SubagentStart','SubagentStop','Stop','SessionEnd')
  ORDER BY created_at;"
```

### Step 2: 表形式でカウンタを手動追跡

抽出したイベントを表にして、各ステップでの `active_subagents` の値を手計算する。

```
| #  | Event          | active_subagents | Note                    |
|----|----------------|------------------|-------------------------|
| 1  | SubagentStart  | 0→1              |                         |
| 2  | SubagentStart  | 1→2              |                         |
| 3  | SubagentStop   | 2→1              |                         |
| 4  | SubagentStart  | 1→2              |                         |
| 5  | SubagentStart  | 2→3              |                         |
| 6  | SubagentStop   | 3→2              |                         |
| 7  | SubagentStop   | 2→1              |                         |
| 8  | Stop           | guard! pending=1  | active>0 なので guard  |
| 9  | SubagentStop   | 1→0 deferred!    | pending=1 → fire       |
```

### Step 3: 期待値と実データのギャップを見つける

手動トレースの結果と DB の実際の値を比較する。

```bash
sqlite3 -header ~/monica/db/monica.db "
  SELECT status, active_subagents, pending_stop
  FROM task_runs WHERE id = 'run-133';"
```

手動トレースでは `pending_stop=1` が設定されるはずなのに DB では `0` → ここがバグ。

## コツ

- **Start/Stop の対応を数える**: increment/decrement 系のイベントは、個数のバランスが崩れていないかまず確認する
- **ignore されるイベントを除外する**: `should_ignore_event` でフィルタされるイベント（非wait系の PreToolUse 等）はカウンタに影響しないので表から除く
- **payload の中身も見る**: `background_tasks` や `stop_hook_active` など、イベント内のフィールドが条件分岐に影響する場合がある
