---
name: attach-task
description: >-
  いま自分が動いている Monica の terminal tab を、既存の Monica Task に
  TaskRun として接続する。「この session を MON-42 に紐づけて」「attach して」
  「この tab を issue #461 に繋いで」「orchestration session として登録して」
  のように、今の会話そのものを Task に結びつけたいと示されたときにトリガーする。
  issue を新規作成して取り込む `track-issue` とは別物で、attach は
  **既存 Task 専用**。
---

# attach-task

`monica task attach` で、いま自分が動いている terminal tab を既存 Task に接続する。

接続すると、この tab は Monica の Workbench 上で **その Task の runspace（bench）へ移動**し、
attach された run がその Task の **Main Run** になる。tab の claude が出す hook は対象 Task の
TaskRun に反映され、「作業中 / 入力待ち」が workboard に映る。「この Task を相談していた
session はこれ」という対応も記録として残る。

GUI からも同じことができる: Workbench の tab を右クリック → **Attach to Task…** → Task を選ぶ。
CLI 経路は Monica が 3 秒ごとに DB を読んで tab を移動するので、移動まで数秒かかる。

## track との違い

|                | 何をするか                                         | 対象           |
| -------------- | -------------------------------------------------- | -------------- |
| `/track-issue` | GitHub issue を作り、Monica に Task として取り込む | **新規** issue |
| `/attach-task` | 今の terminal session を Task に接続する           | **既存** Task  |

attach は Task を作らない。Task がまだ無いなら先に `/track-issue` で作る。

## 手順

### 1. 対象の MON-id を確定する

引数の形で分岐する。

- **`MON-<n>`**（例 `MON-42`）: そのまま使う。
- **GitHub issue 番号 / URL**（例 `#461`、`https://github.com/ashigirl96/monica/issues/461`）:
  タスク一覧の GH ISSUE 列から MON-id を引く。

  ```bash
  MONICA_HOME=$HOME/monica monica task status
  ```

  該当 issue 番号の行が無ければ、その issue はまだ track されていない。
  attach せず「先に track が必要」と報告する（勝手に track しない）。

- **引数なし**: 何に attach するかをユーザーに確認する。推測で繋がない。

### 2. attach する

```bash
MONICA_HOME=$HOME/monica monica task attach <MON-id>
```

成功するとこう出る:

```
Attached MON-42 to this terminal tab.
  Task:    orchestration session: 生の terminal session を Task に紐づける
  Run:     run-73
  Session: 0f9d1c3a-...
  Main Run: yes
  Detached previous runs: run-70
The tab moves into the task's runspace in Monica.
```

`Main Run` は通常 `yes`。その Task に準備中の worktree run（Prepare 直後で SettingUp / Prepared）
がある場合だけ `kept run-N (mid-prepare)` となり、prepared run が Main Run のまま残る
（attach 自体は成功し、hook の追跡も行われる）。

`Detached previous runs` は、この tab が直前まで別の Task を駆動していた場合にだけ出る。
その旧 run は Stopped に落ちて履歴として残る（1 tab につき有効な attach は高々 1 本）。
tab は新しい Task の runspace へ移り、元の runspace が空になればそのまま消える。

### 3. 報告する

MON-id・Task タイトル・run-id をユーザーに伝える。付け替えが起きたなら、
どの run を detach したかも添える。`Main Run: kept ...` だった場合はその旨も伝える。

## エラーの読み方

| メッセージ                                  | 意味                                                    | 対処                                                           |
| ------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------- |
| `this tab is already bound to task MON-<n>` | この tab は Task tab として起動されている               | attach 不要。すでにその Task に紐づいている                    |
| `no Monica terminal tab detected`           | Monica の terminal tab 外（外部ターミナル等）で実行した | Monica の tab 内から実行する。外部ターミナルの attach は未対応 |
| `task not found: MON-<n>`                   | その MON-id の Task が無い                              | `monica task status` で MON-id を確認する                      |
| `task MON-<n> is closed`                    | クローズ済み Task                                       | 対象を選び直す                                                 |

## 補足

- `MONICA_HOME` は必ず `$HOME/monica` を指定する（指定しないと別の data dir を見てしまう）。
- attach した run の agent は claude 固定（Monica が扱う agent は claude だけ）。この値は
  後から補正されず、将来の resume のコマンドライン（`claude --resume`）を決める。
- attach した run はその Task の **Main Run になる**（worktree なし Run と同じ「in-place な
  primary run」）。この claude が動いている間は、その Task の Prepare / Run はどちらも
  「active run あり」で拒否される。claude を終了すると run が Stopped になり、ボードの Run で
  同じ session を元の tab の cwd で resume できる。Prepare もそのとき以降は従来どおり使える。
- runspace の cwd は動かさない。bench が未作成なら tab の cwd で作られ、既にあればそのまま。
  tab の shell 自体の cwd も変わらない。
- detach 専用コマンドは未実装。別 Task に attach し直すと自動で付け替わる。
