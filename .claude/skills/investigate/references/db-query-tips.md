# DB 直接クエリによるデータ確認

## いつ使うか

「X が壊れている」「Y の状態がおかしい」と言われたとき、まず実データの現在の状態を正確に把握する。コードを読む前にデータを見る。

## 実例: TaskRun が running で固着

### Step 1: 問題のレコードを特定

ユーザーが「MON-117」と言ったが、dev DB には存在しなかった。prod DB を確認して発見。

```bash
# dev DB
sqlite3 -header -column ~/monica/dev/db/monica.db \
  "SELECT id, status FROM tasks WHERE id = 'MON-117';"

# prod DB
sqlite3 -header -column ~/monica/db/monica.db \
  "SELECT id, status FROM tasks WHERE id = 'MON-117';"
```

**教訓**: dev と prod の DB パスを両方試す。ユーザーが見ている環境と調査している環境が異なる場合がある。

### Step 2: 問題の範囲を把握

1件だけでなく、同じ症状の全レコードを洗い出す。パターンが見えてくる。

```bash
sqlite3 -header -column ~/monica/db/monica.db "
  SELECT tr.id, tr.task_id, tr.status, tr.last_event_name,
         tr.active_subagents, tr.pending_stop
  FROM task_runs tr
  WHERE tr.status = 'running'
    AND tr.last_event_name IN ('Stop', 'SubagentStop')
  ORDER BY tr.updated_at DESC;"
```

この例では 6 件の固着 run が見つかり、全て `pending_stop = 0` だったことがバグの手がかりになった。

### Step 3: 関連テーブルのスキーマも確認

カラムの型・デフォルト値・制約が問題の手がかりになることがある。

```bash
sqlite3 ~/monica/db/monica.db ".schema task_runs"
```

## コツ

- **全フィールドを出す**: 問題のレコードは `SELECT *` で全カラムを確認する。想定外のカラムの値がヒントになる
- **集計クエリで全体像を掴む**: `GROUP BY` + `COUNT(*)` で傾向を把握してから個別を掘る
- **json_extract でペイロードを分解**: JSON カラムがある場合、`json_extract(payload_json, '$.field')` で中身を展開できる
