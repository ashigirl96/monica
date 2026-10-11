---
status: accepted
---

# Usage は OpenTelemetry で送らず、Backend が monica.db に日ごとの回数で持つ

使われていない Feature を消す候補にするため、Feature ごとの Usage を残す。monica は Mac 1 台で私 1 人が使い、webview・CLI・Chrome Extension・notes の画面の呼び出しはすべて Backend の HTTP の口を通る。そこで Backend が口で Feature と Caller を数え、`(Feature, Caller, 日付)` ごとの成功と失敗の回数を monica.db に持つ。見るのは CLI で、登録されている Feature の一覧と突き合わせ、呼ばれなかった Feature も 0 回として出す。

## Considered Options

- **OpenTelemetry の metrics をローカルの Collector と Grafana などに送る**: 強みは送り先を後から差し替えられることと、process をまたいで trace をつなげることだが、process が 1 台に閉じた私 1 人の道具ではどちらも効かない。Collector と送り先を常駐させる手間が毎日かかり、desktop と同じ寿命の Backend（ADR-0007）が止まっている間は送り先だけが残る。
- **1 回の呼び出しを 1 行の event で残す**: 時刻や引数まで残るが、消すかどうかに要るのは「使われたか、いつまで使われたか」だけで、5 分ごとの呼び出しで行が増え続けて消す仕組みが要る。日ごとの回数なら行は Feature × Caller × 日数に収まり、無期限に残せる。
- **ログから数える**: Backend のログは stderr に出るだけでファイルに残らず、ログの置き方はまだ決めていない。Usage は数えるための記録で、ログの置き方とは切り離す。

## Consequences

- desktop が閉じていて Backend が居ない間の呼び出しは、失敗して Usage に残らない。Backend の寿命の外にある利用は数えない。
- Backend の口を通らない操作（端末の入出力、Tauri command、Ledger の直接呼び出し、system の Job）は Feature ではなく、数えない。
- webview の Usage には、画面が開いたときや描き直すときに自分で打つ読み出しと `changes` の購読も入る。画面の機能を私が使ったかは測れず、0 回で消す候補を探せるのは CLI や Chrome Extension から呼ぶ Feature になる。画面の操作を数えるなら、Feature ではなく UI の操作を単位にした別の記録が要る。
- CLI を私が打ったか agent が打ったかは見分けない。agent が使う Feature を消すと agent の仕事が壊れるので、どちらも「使われた」に数える。
- 時刻や引数を後から知りたくなっても、過去の分は戻らない。
