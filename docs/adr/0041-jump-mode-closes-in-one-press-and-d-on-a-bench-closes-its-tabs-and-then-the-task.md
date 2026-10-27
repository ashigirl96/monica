---
status: accepted
---

# Jump Mode の d と D は 1 度で閉じ、Bench の D は Tab をすべて閉じてから Task を close する

Jump Mode の d は、live な Agent Session がいる Tab ではもう一度 d を求めていた（ADR-0023）。d は c（新しい Tab）の隣のキーで、打ち損じで claude を消さないためだった。Runspace を Tab ごと消す D も同じく 2 度目を求め、Bench は消さずに断っていた。Bench を Workbench から閉じるには、Tab を 1 つずつ閉じるしかなかった。

そこで、Bench でも D を効かせる。D は Bench の Tab をすべて Close Tab で閉じ、最後の Tab を閉じたときと同じく、空になった Bench を task の ui の強制でない close に渡す（ADR-0012）。閉じた Tab の claude は Terminating な Terminal Session にいるので Active Run に数えず、git の guard だけが close を止める。止まった Bench は、Tab の無いまま止めた理由と「Close anyway」を出す（ADR-0036）。

あわせて、d と D の 2 度押しをやめる。d と D はファイルを消さない。worktree を消すのは Task の close だけで、それは git の guard が守る。閉じて失うのは動いている process と claude の途中の応答で、会話は `claude --resume` で戻せる（ADR-0023）。ADR-0023 の「live な Agent Session がある Tab ではもう一度 d を求める」は、この ADR で置き換える。

## Considered Options

- **Bench の D は guard を先に通し、Active Run があれば何も変えない**: 断られても claude と Tab が残る。しかし claude が動いている Bench では D が効かず、claude を終わらせてから押し直すことになる。
- **Backend の `runspace.remove` で、所有された Runspace は Tab だけを消して Runspace を残す**: 1 つの transaction で空にできる。しかし CLI の `workbench runspace remove` も同じ procedure を呼び、CLI からは task の ui の close が走らない。Bench が close されずに Tab の無いまま残る。
- **2 度押しを残す**: Bench の close は git の guard が守るので、D の確認は claude の途中の応答しか守らない。

## Consequences

- Jump Mode の d と D は、閉じる前に live な Agent Session を Backend に聞かない。
- pin された Tab は今までどおり閉じない（ADR-0014）。pin された Tab のある Runspace は、Bench も含めて D で消さない。
- Bench の D は、Tab を 1 つずつ `tab.close` で閉じる。webview が空になった Bench を slot に渡す経路は、最後の Tab を手で閉じたときと同じ 1 つにする。途中の close が失敗したら、残りの Tab は閉じず、Task の close も呼ばない。
- Tab の無い Bench の D は、閉じる Tab が無いので Bench をそのまま slot に渡す。「Close」を押したときと同じく、強制でない close をやり直す。
- Bench の外で動く Run（別の Runspace で resume した claude）は Active Run として close を止める。このとき Bench は Tab の無いまま残る。
- D は強制で close しない。強制の close は、ADR-0036 の 2 度押しの「Close anyway」だけに残す。
