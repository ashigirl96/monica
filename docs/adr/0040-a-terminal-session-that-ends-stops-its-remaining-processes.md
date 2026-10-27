---
status: accepted
---

# Terminal Session が終わったら、shell の session に残った process を SIGTERM と SIGKILL で止める

ADR-0023 は、Terminal Session の終了を shell への SIGHUP だけで行うと決めた。前景の job と claude はこの SIGHUP で終わる。しかし、SIGHUP を無視する process（`nohup`）は、Tab を閉じた後も ppid=1 で動き続け、dev server なら port を握ったままになる。shell が `exit` や Ctrl-D で先に終わった Tab では、その後の Close Tab の Terminate は ptyd の中で何もしないので、閉じる側で探す形ではこの経路を拾えない。

そこで、Terminal Session が終わったら、理由を問わず、ptyd が残った Terminal Session Process を止める。shell が終わってから 2 秒待って SIGTERM を送り、さらに 5 秒たっても残るものに SIGKILL を送る。shell への SIGHUP（ADR-0023）は今までどおり最初に送る。ADR-0023 の「SIGKILL は足さない」はこの ADR で置き換える。

Terminal Session Process は、session id（`getsid`）がその Terminal Session の shell の pid と同じ process。shell は session leader なので、shell から起こした job と、nohup で SIGHUP を無視した process がここに入る。shell が終わった後も、残った process の session id は shell の pid のまま変わらない。setsid で自分の session を作った process は入らない。

## Considered Options

- **今のまま SIGHUP だけにする**: nohup で起こした process が残り、Tab を閉じても port が空かない。
- **env の `MONICA_TERMINAL_SESSION_ID` が一致する process を止める**: setsid で抜けた process も拾える。しかし、Tab の中で最初に使ったときに裏で起動する共有の常駐プログラムも、その Tab の env を引き継ぐ。手元の Mac では、Tab の shell の子孫でないのに目印を持つ process が 31 個あった。Docker Desktop 一式、Claude Code の `claude daemon` と `bg-spare`、codex の app-server-daemon、gpg の `keyboxd` などで、どれも Tab の shell の session の外にいた。起動した Tab を閉じるとこれらが止まり、ほかの Tab や app から使えなくなる。setsid で抜けた dev server と共有の常駐プログラムは、OS から見て同じ形（自分の session か launchd の下）なので、見分けられない。加えて、macOS は Apple の platform binary（`/bin/zsh`、`/bin/sleep`、`/usr/bin/perl`）の env を他の process に読ませない。
- **閉じる前に shell の子孫を控えておき、それを止める**: 起動した瞬間に親を終わらせて ppid=1 になる process は、閉じる前から子孫の外にいる。`exit` で shell が先に終わる経路では、控える時点も無い。
- **Linux の cgroup のように Terminal Session ごとに process を囲う**: macOS には公開された同じ仕組みが無い。
- **SIGHUP から 10 秒後に SIGTERM、さらに 30 秒後に SIGKILL**: 片付けの時間は長くなる。しかし、最初の待ちで待つのは claude の SessionEnd の hook（1.5 秒から）だけで、この時点で残るのは SIGHUP に応じなかった process なので、長く待っても自分からは終わらない。残った dev server が最長 40 秒 port を握り、待つ間に ptyd が終わって掃除が飛ぶ時間も延びる。

## Consequences

- 最初の 2 秒は、SIGHUP を受けた claude が SessionEnd を送り終える時間で、ADR-0023 が SIGKILL を足さなかった理由をこの待ちで守る。この待ちが守るのは claude が走らせる SessionEnd の hook の後始末で、monica の hook が送る SessionEnd は、Terminal Session がすでに終わっているので記録されない（ADR-0008 の既知のずれ）。SIGTERM から SIGKILL までの 5 秒は、SIGTERM に応じる process が片付けを終える時間。port は長くても 7 秒で空く。
- Tab の中から nohup で起こした process を、Tab より長生きさせる手段は無くなる。Tab より長生きさせる process は、setsid で自分の session を作って起こすか、monica の Tab の外で起こす。
- setsid で抜けた process は Tab を閉じても残る。claude の Bash tool が background で起こす command も自分の session にいるので、止めるのは claude 自身の片付けに任せる。
- pin された Tab の shell が終わって張り直すときも、前の Terminal Session の process は止める。張り直した Terminal Session の shell は別の pid で、別の session を持つ。
- 待っている間に ptyd が終わる（更新で入れ替わる、home が消える）と、その Terminal Session の掃除は行われない。
