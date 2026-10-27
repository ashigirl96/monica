---
status: accepted
---

# Terminal Session が終わったら、残った Terminal Session Process を SIGTERM と SIGKILL で止める

ADR-0023 は、Terminal Session の終了を shell への SIGHUP だけで行うと決めた。前面の job と claude はこの SIGHUP で終わる。しかし、SIGHUP を無視する process（`nohup`）と、別の session に移って端末から離れた process（`setsid`）は、Tab を閉じた後も ppid=1 で動き続け、dev server なら port を握ったままになる。shell が `exit` や Ctrl-D で先に終わった Tab では、その後の Close Tab の Terminate は ptyd の中で何もしないので、閉じる側で探す形ではこの経路を拾えない。

そこで、Terminal Session が終わったら、理由を問わず、ptyd が残った Terminal Session Process を止める。shell が終わってから 2 秒待って SIGTERM を送り、さらに 5 秒たっても残るものに SIGKILL を送る。shell への SIGHUP（ADR-0023）は今までどおり最初に送る。ADR-0023 の「SIGKILL は足さない」はこの ADR で置き換える。

Terminal Session Process は、同じ user の process のうち、env の `MONICA_TERMINAL_SESSION_ID` がその Terminal Session の id のものと、shell の子孫を合わせたもの。setsid で抜けた process も、env は親から引き継ぐので見つかる。macOS では `sysctl` の `KERN_PROCARGS2` で他の process の env を読む。Tab の show が出す process の一覧も、この同じ定義で ptyd から取る。

## Considered Options

- **今のまま SIGHUP だけにする**: nohup と setsid で抜けた process が残り、Tab を閉じても port が空かない。
- **shell の session の process を止める（`KERN_PROC_SESSION`）**: nohup の子は shell が終わった後も shell の session 番号を持つので拾える。setsid で抜けた process と、claude が Bash tool の command を置く別の session は拾えない。
- **閉じる前に shell の子孫を控えておき、それを止める**: 起動した瞬間に親を終わらせて ppid=1 になる process（setsid の fork と exit）は、閉じる前から子孫の外にいる。`exit` で shell が先に終わる経路では、控える時点も無い。
- **Linux の cgroup のように Terminal Session ごとに process を囲う**: macOS には公開された同じ仕組みが無い。
- **SIGHUP から 10 秒後に SIGTERM、さらに 30 秒後に SIGKILL**: 片付けの時間は長くなるが、最初の待ちで待つのは claude の SessionEnd の hook（1.5 秒から）だけで、この時点で残るのは SIGHUP に応じなかった process なので、長く待っても自分からは終わらない。抜け出した dev server が最長 40 秒 port を握り、待つ間に ptyd が終わって掃除が飛ぶ時間も延びる。

## Consequences

- 最初の 2 秒は、SIGHUP を受けた claude が SessionEnd を送り終える時間で、ADR-0023 が SIGKILL を足さなかった理由をこの待ちで守る。SIGTERM から SIGKILL までの 5 秒は、SIGTERM に応じる process が片付けを終える時間。port は長くても 7 秒で空く。
- Tab の中から nohup や setsid で起こした process を、Tab より長生きさせる手段は無くなる。Tab を閉じても残したい process は、monica の Tab の外で起こす。
- pin された Tab の shell が終わって張り直すときも、前の Terminal Session の process は止める。張り直した Terminal Session は別の id を持つ。
- 次の process は見つけられずに残る。
  - env を消して起こした process（`env -i` など）。
  - Apple の platform binary（`/bin/sleep`、`/usr/bin/perl` など）。macOS は他の process にその env を読ませないので、setsid で抜けたものは見つからない。shell が生きている間の子孫は見つかる。
  - 別の user の process（`sudo` で起こしたものなど）。
- 待っている間に ptyd が終わる（更新で入れ替わる、home が消える）と、その Terminal Session の掃除は行われない。
