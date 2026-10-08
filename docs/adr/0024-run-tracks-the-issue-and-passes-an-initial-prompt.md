---
status: accepted
---

# run は未 track の issue を track し、claude に最初の prompt（既定は `/tackle`）を渡す

#12 は、Run の claude に initial prompt（旧 Monica の `.monica/prompt.md`、この repo では `/tackle`）を渡さないと決めていた。Task の文脈は env と `monica task current` で agent が自分で引けるため。しかし、どの repo にも `/tackle` の Skill を置く運用では、issue から作業を始めるのに `track`・`run`・Tab での `/tackle` の 3 手が要っていた。そこで `run` は prompt を受けて claude に渡し、省けば `/tackle` を渡す。未 track の issue を受けたら `NOT_FOUND` で断らず、track してから進める。issue の URL を 1 つ渡して `monica task run <url>` を打てば、agent が作業を始める。

## Considered Options

- **渡さない（#12 のまま）**: Run を始めるたびに、Tab で `/tackle` を打つ手が残る。
- **per-repo の `.monica/prompt.md`（旧 Monica）**: どの repo も `/tackle` なので、全 repo に同じ file を置くことになる。per-repo の設定は settings の fog のまま（#12）。
- **既定の prompt を settings で変えられるようにする**: settings はまだ無い（`docs/packages.md` の「ここで決めていないこと」）。`/tackle` 以外を使う repo が出てから足す。
- **既定を `/tackle <issue の URL>` にする**: worktree の Bench は branch `issue-<n>` を切り、tackle はその名前から issue を読むので、付けなくても足りる。`--in-place` の Bench では branch から issue が分からないが、それは受け入れる。
- **issue の URL のときだけ track する**: `owner/repo#n` の打ち間違いは、実在する別の issue を track して `/tackle` を始めうる。ただ、ref の 2 つの形は Backend で同じものになり、書き方で挙動が変わる規則は忘れやすい。output に title が出るので、間違いには気づける。
- **closed な Task も reopen してから run する**: 未 track の issue を track するのは、まだ無いものを作るだけだが、reopen は close の決定を取り消す。同じ Issue への再挑戦は reopen で表す（`GLOSSARY.md` の Task）ので、明示の操作のままにする。

## Consequences

- CLI は `monica task run <ref> [prompt]` で、prompt は 2 つ目の位置引数。
- prompt は Tab の shell に打つ行の後ろに single quote で囲んで足す（`claude '/tackle'\r`）。claude wrapper は最初の引数が prompt なら `--settings` を足す（`docs/packages/tab-env-and-shim.md`）。prompt が claude の subcommand と同じ 1 語（`doctor` など）なら、subcommand として動く。
- resume では、prompt を指定したときだけ `claude --resume '<id>' '<prompt>'` で渡し、既定の `/tackle` は送らない。resume する Agent Session は tackle の途中か後で、もう一度送ると branch を切るところからやり直すため。
- prompt は Task にも Run にも保存しない。Terminal Session Transcript には残る。
- 素の `claude` で起こす手段は持たない。別のことをさせたいときは別の prompt を渡す。
- monica は `/tackle` を配らない（ADR-0006 は repo を開発する skill を配らない）。`/tackle` の無い repo では、claude は `/tackle` を実行できない。
- 未 track の ref は、`track` と同じく写しと Task の行を 1 つの transaction で書いてから、新しい Run の手順（sync・Blocker gate・Bench の準備）に進む。その後で `run` が失敗しても（`BLOCKED`、準備の失敗、ptyd に繋がらない）track は残す。`track` を打ってから `run` を打ったのと同じ状態になる。output の `tracked` が、この `run` で track したかを示す。
- closed な Task への `run` は、今どおり `BAD_REQUEST` で reopen を案内する。
