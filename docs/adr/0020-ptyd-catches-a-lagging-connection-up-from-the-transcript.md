---
status: accepted
---

# ptyd は読み遅れた接続を切らず、transcript から追いつかせる

Terminal Session の出力の正本は transcript にする。接続ごとの送信キューは、transcript の末尾の手前に置いたキャッシュとして扱う。キューが溢れても、ptyd は接続を fanout から外さない。その (Terminal Session, 接続) を「遅れている」にして、どこまで送ったか（transcript の通し位置）を覚え、live の送信を止める。キューが掃けたら、覚えた位置から今までの分を transcript から送り、送り切ったら live に戻す。追いつきと live への戻しは Terminal Session の table の lock の中で行う。そのため、追いつきと live の継ぎ目に抜けも重複も無い。attach の replay と配信登録を 1 つの lock で行うのと同じ理屈。Shell と webview は変えない。

以前の ptyd は、溢れた接続を fanout から外し、socket は閉じなかった。Shell は外されたことに気づけず、以後どの Tab にも出力が届かない。それでも入力は shell に届き続け、desktop を起こし直すまで戻らなかった。1409 files の `git pull` の diffstat（約 200KB）が流れている最中に Workbench の全 Tab が固まったのが、これに当たる。

試作（branch `prototype/ptyd-lag`）で確かめたこと:

- Shell は遅くない。optimized の dev desktop で 200〜3000 フレームの burst を流すと、Shell の reader が処理に使うのは合計 2〜18ms で、残りは socket を待っている。全 core の CPU 負荷、他の Tab の出力、窓の最小化でも、キューは 32 フレームに届かない。
- 引き金は Shell の reader が数百 ms 止まること。止まった理由は OS 側にあり、特定できていない。macOS の PTY は 1 回の read で 1024 byte までしか返さないので、200KB の出力は 200〜370 フレームになり、256 フレームのキューは Shell が一瞬止まるだけで溢れる。
- 実 Workbench（Tab 5 つ、Shell の reader を 1.5 秒止める、diffstat と 4 Tab の出力）: 以前の ptyd は全 Tab が固まる。この形では固まらず、xterm の画面の 1410 行の SHA-256 が元データと一致した。
- ptyd 単体の harness（reader を 1〜2 秒止める、6 回）: 以前の ptyd はすべて固まる。この形は 6/6 回、受け取ったバイト列が transcript と一致した。
- 6MB を流して 6 秒止めると、transcript の保持を超えた 3.96MB を失ったと log に出し、残りで追いついて live に戻った。

閾値は試作のものを使う。256 のキューのうち、live の送信は 224 で止め、応答と Exit の余地を残す。追いつきは 192 までしか詰めない。そうすれば、同じ接続の他の Terminal Session の live の出力は追いつきの最中も入る。追いつきは、writer がキューを 64 まで掃いたときに起こす。

## Considered Options

- **溢れたら socket を閉じ、Shell に繋ぎ直させる**: Shell に繋ぎ直しと全 Tab の attach し直しを足すことになる。溢れたのが 1 つの Terminal Session でも、同じ接続のすべての Tab が replay（末尾 256KB）からやり直しになる。replay に入らない分の出力は画面に戻らない。
- **キューを大きくする**: Shell が止まる長さに上限は無いので、溢れる閾値が上がるだけで、溢れたときに黙って固まる振る舞いは残る。接続ごとのメモリも増える。
- **フレームをまとめる**（PTY の read を束ねて大きなフレームにする）: フレーム数は減るが、長く止まれば同じく溢れる。束ねるために待てば、対話の出力が遅れる。

## Consequences

- 遅れている間も、その接続の request には応答が返る。live の出力がキューの 224 で止まり、応答と Exit の席が残るため。
- 遅れたまま detach して attach し直すと、replay から始まり、古い範囲は送り直さない。attach は (Terminal Session, 接続) を live に戻す。
- ptyd の log に、接続が Terminal Session で遅れ始めたことと、追いついたこと（遅れていた時間）が出る。同じことが起きたときに時刻を追えるようにするため。
- transcript の保持（1〜2MB）を超えて遅れると、保持から落ちた分は届かない。ptyd は失ったバイト数を log に出し、残っている最古の位置から続ける。続きの前と、追いついて live に戻るか Exit を送る前に、端末のモードを戻す。落ちた分に alt screen への出入り、マウスの報告、bracketed paste、kitty keyboard の push などがあっても、webview の xterm のモードが ptyd の追うモードからずれないようにするため。範囲を失っていない追いつきには送らない。
- 戻しは 2 回に分ける。続きの先頭では buffer だけを合わせる。続きの出力がどちらの buffer に描かれるかは、そこで決まるため。接続の xterm が alt screen にいれば、kitty keyboard の stack を空にして抜け、main の stack も空にする。続きが alt screen で始まるなら入る。ほかのモードは、追いついて live に戻るか Exit を送る直前に、ptyd が追う今のモードをすべて言い直す。既定値のモードも言い、kitty keyboard の stack は空にしてから積み直す。続きの中のモードの切り替えを見なくても、今の状態に揃う。
- attach の replay の戻しを使わないのは、それが開いたばかりの端末を前提に、既定値と違うモードしか言わず、kitty keyboard の stack を積み足すため。落ちた分で app が alt screen を抜けていても xterm は抜けず、push は二重に積まれ、続きにある pop は外側の entry まで消しうる。xterm 6.1 は kitty keyboard の stack を buffer ごとに持ち、今いる buffer の stack しか pop しない。alt screen にいる xterm に `?1049h` を送り直すと、flags を buffer の間で入れ替えてしまう。そのため alt screen にいたままでも、一度抜けてから入り直す。
- 接続の xterm がどの buffer にいるかは、遅れ始めた位置の buffer を覚え、追いつきで送ったものを追って知る。ptyd の alt screen の履歴には件数の上限（256）があり、遅れている間に切り替えが多いと、遅れ始めた位置まで遡れないため。続きがどちらの buffer で始まるかはその履歴から引くので、残っている続きに上限を超える切り替えがあると、続きの最初の切り替えまでの出力は違う buffer に描かれうる。attach の replay と同じ制限で、最初の切り替えから後は正しい buffer に戻る。
- 遅れている間にその Terminal Session の shell が終わると、ptyd はまだ送っていない分を transcript からメモリに写し、追いつきでそれを送り切ってから Exit を送る。Exit を受けた Backend はすぐ Reap で transcript を消すので、写さなければ後から読めないため。写しは (Terminal Session, 接続) ごとに持ち、大きさは transcript の保持（1〜2MB）を超えない。Exit を積むか接続が切れるまで残る。
- 終わったときにキューが満杯で Exit を積めなかった接続には、キューが掃けた後の追いつきで Exit を送る。どの接続でも、Exit はその Terminal Session の出力の後に届き、Exit の後にその Terminal Session の出力は届かない。
- ptyd が接続を外すのは、socket の EOF と、応答をキューに積めなかったときだけになる。後者は、相手が読まずに 30 を超える request を送り続けたときにしか起きない。
