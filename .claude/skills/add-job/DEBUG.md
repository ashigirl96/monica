# Job が成功しなかったとき

原因を 1 つの行か設定に絞り、直した Job が `run` で `succeeded` になれば完了。

## 1. 結果で分ける

`monica job show <名前>` の最新の行の RESULT を読む。

- `failed`: 0 以外で終わった。ERROR は `exit <code>: <LOG の最後の行>` か `killed by <signal>` になる。LOG を読み、最初に失敗した行を探す。
- `timed_out`: `--timeout` を超え、process group ごと kill された。LOG は途中で切れている。最後に出た行の次で止まっている。
- `interrupted`: 途中で Backend が止まった。Job の問題ではないので、`run` で走らせ直す。
- 行が無い・LAST が古い: 予定の時刻に Backend が居なかったか、`paused` のまま。`monica job list` の STATE と NEXT を見る。

## 2. Backend と同じ条件で再現する

LOG だけで分からなければ、`show` の CWD と COMMAND をそのまま手元で走らせる。Backend は login shell の PATH で、stdin も TTY も無しに起こす。

```bash
cd <CWD> && zsh -lc '<COMMAND>' < /dev/null 2>&1 | tail -20; echo "exit ${pipestatus[1]}"
```

- 手元では通る: Tab の env にしか無いもの（`MONICA_*`・Tab の claude wrapper・`.envrc`）に頼っている。script の中で path か env を明示する。
- 止まって返らない: 対話を待っている。非対話の flag を付ける。
- `claude -p` の result 行に `permission_denials` がある: 拒否された tool を `--allowedTools` に足す。

## 3. 直す

script だけを直すなら、`monica job run <名前>` で走らせ直す。command・cron 式・cwd・timeout を変えるなら remove して add し直す。remove は過去の Job Execution と LOG も消すので、調べ終えた LOG だけが残っているときに消す。
