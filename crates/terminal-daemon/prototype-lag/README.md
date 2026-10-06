# PROTOTYPE: 出力が詰まった接続を ptyd がどう扱うか（捨てる branch）

main には入れない。答えた問いと結果をここに残す。

## 問い

git pull の大量出力の途中で Workbench が固まった（ptyd の log に `dropping lagged connection`）。Shell が遅いのか、何が根本で、どう直せば固まらないか。

## 結果

- Shell は遅くない。optimized の dev desktop で 200〜3000 フレームの burst を流すと、Shell の reader が処理に使うのは合計 2〜18ms で、99% は socket を待っている。all-core の CPU 負荷、他の Tab の出力、窓の最小化でも ptyd の queue は 32 フレームにも届かない。
- 引き金は Shell の reader の数百 ms の一時停止。burst の最中に止まると、接続ごと 256 フレームの queue が溢れる。macOS の PTY は 1 回の read で 1024 byte までしか返さないので、200KB の出力が約 200〜370 フレームになる。
- 根本は ptyd の扱い。溢れた接続を fanout から外すが socket は閉じないので、Shell は気づかず、全 Tab の出力が止まったまま入力だけが届く。
- `resume`（この branch の ptyd）: 溢れた (session, 接続) を「behind」にして live の送信を止め、queue が掃けたら transcript の `tail(written - since)` から送り直す。table の lock の中で live に戻すので、隙間も重複も無い。client は変えない。

| 実験 | drop（出荷中） | resume |
|---|---|---|
| 実 Workbench、Shell を 1.5s 止める、diffstat + 4 Tab の出力 | 全 Tab が固まる。後から書いた行は transcript にあるが画面に出ない | 固まらない。xterm の 1410 行の SHA-256 が fixture と一致 |
| harness、1〜2s 止める、×6 | RED | GREEN 6/6、受け取った byte 列が transcript と一致 |
| harness、6MB を 6s 止める（transcript の保持を超える） | RED | 3.96MB を rotation で失ったと log に出し、追いついて live に戻る |

## 未決

- transcript の保持（1〜2MB）を超えて遅れたとき、失った分をどう見せるか。attach と同じく `modes.restore_prefix` を前置するのが候補。
- behind のまま session が exit すると、残りを送らずに捨てる。
- Exit の broadcast は queue が満杯だと落ちる（今の main でも同じ）。

## 動かし方

```sh
python3 make_diffstat.py > /tmp/diffstat.txt
# 1 本の ptyd で drop と resume を比べる（Shell 不要）
python3 burst_loop.py --ptyd ../../../target/debug/tania-ptyd --policy drop   --fixture /tmp/diffstat.txt --stall-ms 1000 --noise-sessions 4
python3 burst_loop.py --ptyd ../../../target/debug/tania-ptyd --policy resume --fixture /tmp/diffstat.txt --stall-ms 1000 --noise-sessions 4
# 実 Workbench: dev desktop で Tab を 5 つ開き、Shell の reader を 1.5s 止める
python3 lag_experiment.py --home "$TANIA_HOME" --target <ts-id> --noise <ts-id>... --policy drop --shell-stall-ms 1500 --fixture /tmp/diffstat.txt
```
