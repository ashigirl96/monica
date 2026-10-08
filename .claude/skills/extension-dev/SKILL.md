---
name: extension-dev
description: "dev の Chrome Extension を headless の Brave に読み込ませ、side panel を開いて中身を読み、撮る。受け入れ条件を side panel で確かめるとき、Chrome Extension の HMR と reload を見るときに使う。"
---

`bun run extension` は、home ごとの port の Vite と、home ごとの profile（`$MONICA_HOME/dev-brave`）の Brave を起こし、dev の出力（`$MONICA_HOME/dev-extension`）を読み込ませる。`--headless` を付けると Brave に CDP の port を開け、`scripts/extension-panel.ts` がその port で side panel を操作する。ユーザーや別の worktree の Brave も同じ machine で動いているので、自分の Brave は home で見分ける。

## 起こす

1. home は `${TMPDIR%/}/monica-<worktree の名前>`（名前は `basename "$(git rev-parse --show-toplevel)"`）に固定する。Vite の port と Brave の profile は home から決まる。
2. Bash の `run_in_background` で起こし、出力は scratchpad の file に向ける。終わったら印の行を足し、待つ側が抜けられるようにする。

   ```bash
   MONICA_HOME=${TMPDIR%/}/monica-<名前> bun run extension --headless > $SCRATCH/extension.log 2>&1; echo '[extension exited]' >> $SCRATCH/extension.log
   ```

   起動できたのは、log に `[extension] ready` が出たとき。待つのは、Bash の `run_in_background` で `until grep -qE '^\[extension\] ready|^\[extension exited\]' $SCRATCH/extension.log; do sleep 0.5; done` を走らせる。`[extension exited]` で抜けたら log を読む。Chrome Extension の port が埋まっていると、Vite が `Port … is already in use` で落ち、Brave は起きない。新しい profile では、script が先に headless の Brave を一度起こして開発者モードを書かせるので、数秒長くかかる。

3. Backend が要るときは、backend-headless の「起こす」で同じ home に起こす。`bun run extension` は Backend を起こさない。

## 確かめる

`scripts/extension-panel.ts` は、`$MONICA_HOME/dev-brave/DevToolsActivePort` の port に繋ぐ。

```bash
MONICA_HOME=${TMPDIR%/}/monica-<名前> bun scripts/extension-panel.ts open
MONICA_HOME=${TMPDIR%/}/monica-<名前> bun scripts/extension-panel.ts eval 'document.body.innerText'
MONICA_HOME=${TMPDIR%/}/monica-<名前> bun scripts/extension-panel.ts screenshot $SCRATCH/panel.png
```

- `open`: toolbar の action のクリックと同じ経路（CDP の `Extensions.triggerAction`）で side panel を開き、その target の id を出す。action は開閉を切り替えるので、開いていれば押さずに id だけを出す。
- `eval '<js>'`: side panel で式を評価し、値を JSON で出す。user gesture 付きで評価し、Promise は待つ。例外は stderr に出して exit 1 する。
- `screenshot <path>`: side panel を png で撮る。Read で見る。
- `apps/extension/src/sidepanel/` の編集は、開いたままの side panel に HMR で届く。`src/background.ts` を編集すると、CRXJS が Chrome Extension を reload する。reload の後に side panel を見るときは、もう一度 `open` を打つ。

`Extensions.triggerAction` が使えないときは、拡張の page を Browser Tab で開き、そこから `chrome.sidePanel.open` を user gesture 付きで呼ぶ。Current Page が拡張の page に変わるので、Current Page を見る確かめには `open` を使う。dev の ID は `docs/packages/extension.md` にある。

```bash
MONICA_HOME=${TMPDIR%/}/monica-<名前> bun -e '
const { attach, browserEndpoint, connectCdp, evaluate } = await import(`${process.cwd()}/scripts/cdp.ts`);
const cdp = await connectCdp(browserEndpoint(`${process.env.MONICA_HOME}/dev-brave`));
const { targetId } = await cdp.send("Target.createTarget", { url: "chrome-extension://<dev の ID>/src/sidepanel/index.html" });
const session = await attach(cdp, targetId);
await Bun.sleep(1000);
await evaluate(cdp, session, "chrome.windows.getCurrent().then((w) => chrome.sidePanel.open({ windowId: w.id }))", { userGesture: true });
cdp.close();'
```

### agent-browser

- `--session <固有の名前> --cdp <port>` で、同じ Brave の Web ページを操作できる。port は `head -1 $MONICA_HOME/dev-brave/DevToolsActivePort`。
- `tab list` には、自分で開いていない拡張の page と side panel が出ない。side panel は `extension-panel.ts` で見る。
- `eval` には user gesture が付かないので、`sidePanel.open()` が拒まれる。
- `close` は Brave を止めない。止めるのは下の `dev:kill`。

## 止める

`bun run dev:kill monica-<名前>` で止める。Brave を止めると、`bun run extension` が Vite を止めて抜け、log に `[extension exited]` が出る。同じ home の Backend と ptyd も同じ command で止まり、`$TMPDIR` の下の home（profile と dev の出力を含む）は消える。片付いたのは、`bun run dev:list` に `monica-<名前>` の行が無くなったとき。
