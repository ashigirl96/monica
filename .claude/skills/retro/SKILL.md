---
name: retro
description: "コーディングセッションの retrospective を行い、agent の環境の改善点を挙げる。振り返りを頼まれたときに使う。"
---

**retrospective** を行う。今後の run が良くなるように、コーディング agent の**環境**の改善点を提案する。

## 手順

1. Skill tool で `mattpocock-skills:writing-for-agents` を呼び、書き方のガイドを読む。

2. 対象のセッションの一次資料を読む。このマシンのセッションログを探すこともある。セッションの指定が無ければ、現在のセッションを対象にする。

3. 次の観点で改善の候補を探す。

- **Navigation**: agent が正しいファイルにたどり着くのは簡単だったか。ファイル間に隠れた依存は無いか。**navigation pointer** があれば見つけやすくなるか。_使いどころ_: 情報を見つけるのにセッションが長くかかったとき。
- **Automated checks**: agent のミスを捕まえられる自動チェックは無いか。lint、型、テスト、ファイルシステムの linter など。まず repo 自身の check コマンド（`package.json` やビルドツールの `lint`/`check` スクリプト、CI の workflow）を読む。すでにあるのに繋がっていない、あるいは黙って壊れているチェックがあれば、作り直すのではなくそれを指摘とする。**guardrail** の無い repo（pre-commit hook も、lint・型チェック・テストを回す CI の job も無い）は、それ自体が指摘になる。lint の無い repo は中立な既定ではなく、機会を逃し続けている状態である。_使いどころ_: 自動チェックで捕まえられたはずのミスを agent がしたとき、または repo に guardrail がまったく無いとき。
- **Coding standards**: **reviewer agent** に新しいルールを課すべきか。既存のルールを外すか明確にすべきか。まず違反を分類する。**mechanical** な違反（決まった構文パターン、禁止された API、import の形、ファイル配置のルール）には、必ず決定的なチェックを当てる。repo の言語と既存の guardrail から見て最も安いもの、つまり repo 自身の linter のカスタムルール、新しい pre-commit hook、新しい CI の job のいずれかにする。ルールを書くより、チェックを作るのを既定にする。`CODING_STANDARDS.md` は本物の **judgement call**（ファイルをまたぐ一貫性、「周囲のスタイルに合っている」など、どんな guardrail でも代わりにならないもの）のために取っておく。_使いどころ_: reviewer agent がミスを見逃したとき。
- **Global AGENTS.md**: coding standards（または自動チェック）へ移すべき指示は無いか。_使いどころ_: AGENTS.md が特に大きいとき（repo でもユーザーの global でも）。
- **Tool economy**: agent が高くつく tool 呼び出しをしていないか。それを簡素にできるか。token 効率の特に悪い独自ツール（CLI、MCP）は無いか。_使いどころ_: agent が高くつく tool 呼び出しをしたとき。
- **No-ops**: steering ファイルの中から、agent の振る舞いを変えない指示を探す。_使いどころ_: steering ファイルが大きく扱いにくいとき。
- **Information access**: agent が情報に届く機会を増やせないか探す。dev server のログを tee する、third-party サービスへの読み取り専用アクセスなど。_使いどころ_: 決定的に重要な情報に agent が届かなかったとき。

4. 候補を深刻な順にユーザーに示す。

## 参照

### 実装とレビュー

作業はすべて、実装とレビューの 2 段階を通る。実装 agent は **context pressure** が最も高い。探索、コードを書くこと、失敗のデバッグを担う。

レビュー agent は context pressure が最も低い。diff を受け取るので探索は要らない。コードを書いたりデバッグしたりする必要もたいてい無い。

だから coding standards を課すのは、実装 agent ではなくレビュー agent の役目にする。

### ファイル

repo の次のファイルを使える。

- `CLAUDE.md`/`AGENTS.md`: この repo で働くすべての agent の context window に入る。ごく控えめに、たいていは他のファイルへの **navigation pointer** だけに使う。
- `CODING_STANDARDS.md`: 実装ではなくレビューのときに読まれる。1,000 行を超えたら、docs フォルダへの **navigation pointer** を足す。
- Docs: 参照用のファイルとして使い、他のファイルから指す。新しく書く前に既存の docs を探す。
- Skills: docs として使う（description が agent の context window に入るため）か、ユーザーが呼ぶコマンドとして使う。`mattpocock-skills:writing-for-agents` の助言に従う。
