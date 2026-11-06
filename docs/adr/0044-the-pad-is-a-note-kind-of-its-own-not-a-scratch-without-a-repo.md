---
status: accepted
---

# Repo に属さない 1 枚は、Scratch を広げずに Note の種類 Pad として足す

Daily は日ごとに流れ、Repo Note は固まった話題を書く。その間に、Repo を切り替えずに開けて、全体で 1 枚だけある書き足し続ける Note がほしい。そこで Note の種類に Pad を足し、1 枚だけであることは DB の一意制約で守る。Scratch は「Repo ごとに 1 つ・Repo で名指す」のまま残す。Scratch の画面・URL・表示名は Scratch に Repo があることに頼っているので、Repo を空にすると、それを読む所すべてに Repo の無い場合の扱いが要る。新しい種類なら、種類で分ける所の足し忘れを型検査が示し、title・Repo・削除・Star の制約は今のまま Pad にも効く。

## Considered Options

- **Repo の無い Scratch を 1 つ許す**: Repo の制約を変えるので、DB の table の作り直しは Pad を足す場合と同じだけ要る。Repo ごとの一意制約は Repo の無い行を互いに別の値と数えるので、1 枚に絞る制約も別に要る。
- **`repo = ''` のような印を置き、今の制約をそのまま使う**: schema は変わらないが、空の Repo が Repo の候補と表示名に出る。印を除くのを書き忘れても、型も制約も止めない。
- **メモ用の Repo の Scratch を Daily の画面から開く**: schema は変わらないが、その Repo が Repo の候補と Note Mention の表示名に出る。
- **note の外（別の table や localStorage）に置く**: Note Mention・Synced Block・画像の掃除・保存の競合の判定は、どれも note の行と `note-N` の id の上で動いている。外に置くと、これらをすべて作り直すことになる。

## Consequences

- 種類の制約を変えるので、移行で note の table を作り直す。
