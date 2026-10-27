---
status: accepted
---

# Task の close は worktree を捨て場へ rename して返し、中身は system の Job が消す

Task の close は、`git worktree remove` が worktree のファイルを node_modules ごと消し終わるまで返らなかった。66k ファイルの worktree で 3.5〜5 秒かかり、GitHub の Sync と合わせて、Bench の画面と CLI の `monica task close` を待たせていた。git は Bun.spawn で動くので Backend は止まらないが、時間のほとんどは unlink の system 時間で、速い削除の道具に替えても秒の単位は残る。

そこで、close は worktree を同じ disk の捨て場（monica home の `trash/worktrees/<uuid>/tree`）へ rename し、git の登録を外して branch を消してから transaction を走らせて返す。中身は task の system の Job `task.worktree-sweep` が 10 分ごとに消す。66k ファイルで、close の git の部分は 0.2〜0.3 秒になる。

強制でない close の guard は、rename の後に作り直す。今は、検査の後に worktree へ書かれた変更を、強制でない `git worktree remove` が断っていた。rename は変更を見ないので、rename した後の捨て場で `git status` を取り直し、変更があれば rename で元の path へ戻して断る。git の remove も「status を取ってから消す」の 2 段なので、守る範囲は変わらない。lock された worktree も同じ時点で断る。

順序は ADR-0012 の「guard → worktree と branch の削除 → transaction」のまま、「削除」を「捨て場への rename、取り直した guard、登録の解除、branch の削除」に置き換える。git が失敗したら transaction を走らせずに止まる、という決定は変えない。

## Considered Options

- **先に git の登録を外してから rename する（最初のたたき台）**: 登録を外すと捨て場で git が動かず（`not a git repository`）、guard を取り直せない。
- **`git worktree move` で捨て場へ移す**: 変更を見ずに通り、登録が捨て場を指して残る。`branch -D` と reopen の `worktree add` が断られ、結局登録を外す手順が要る。
- **登録の解除と branch の削除を transaction の後に回し、失敗は warning にする**: Task が closed なのに branch や登録が残る状態ができる。2 つ合わせて 0.07 秒で、後ろへ回す得が無い。
- **close 全体か `git worktree remove` を応答の後に背景で走らせる**: 断った理由を応答で返せず、ADR-0036 の「Close anyway」が成り立たない。remove が断ったときには Task がもう closed で戻せない。
- **rename の直後に背景で rm し、Job を持たない**: 消し終わる前に Backend が落ちると、取り残しを拾う者がいない。
- **捨て場を戻すか消すかを DB の Bench の行で決める**: reopen した Bench が同じ path を使うので、どの close の跡か見分けられない。

## Consequences

- 捨て場の `<uuid>/` は、rename の前に元の path を書いた `restore-to` を持ち、取り直した guard を通ったら消す。`restore-to` は「まだ guard を通っていない」印で、名前や DB に頼らずこの印の有無だけで戻すか消すかを決める。
  - task の `start()` は、`restore-to` のある捨て場を元の path へ rename で戻す。戻す先に中身があれば、戻さず印も残し、中身を失わない。`tree/` の無いものは消す。
  - `task.worktree-sweep` は、`restore-to` が無く、作ってから 60 秒以上たったものだけを消す。60 秒は、Terminate の後に残った process が止まる 7 秒（ADR-0040）を越えるため。消すのは子 process の `rm -rf` で、Backend の event loop を止めない。失敗した回は failed として記録し、次の回が続きを消す。system の Job は起動時にも走るので、前の Backend が消し損ねたものも拾う。
- rename に失敗したら（別の disk への `EXDEV` など）、今の `git worktree remove` に戻す。遅いが、guard は今のまま働く。
- 強制の close は guard の取り直しを飛ばすだけで、rename・登録の解除・branch の削除は同じにする。意味は「変更を捨てて閉じる」のまま。
- close の後に cwd が worktree の中にある process は、消えた directory ではなく捨て場の中に書く。書いたものは Job が消すので、残らないことは今と同じ。close を呼んだ Tab（`spare`）の cwd は、Job が消すまで捨て場を指す。
- rename から登録の解除までの数十 ms の間に、手で `git worktree prune` を打つと、戻した worktree が壊れた登録を指す。手作業と重なる場合だけなので受け入れる。
- 取り直した guard も今の検査と同じく `--untracked-files=normal` で見るので、ignored な file への書き込みは守らない。今の guard も守っていない。
- GitHub の Sync を待つ時間は、この決定では変えない。
