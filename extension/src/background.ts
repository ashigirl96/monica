declare const __TRANSLATE_PORT__: number;

const WS_URL = `ws://127.0.0.1:${__TRANSLATE_PORT__}/ws/translate`;

interface Segment {
  seg: number;
  text: string;
}

interface TranslateRequest {
  type: "translate";
  segments: Segment[];
}

function injectContentScript(tabId: number) {
  chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"],
  });
}

chrome.action.onClicked.addListener((tab) => {
  if (tab.id) injectContentScript(tab.id);
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "translate-page" && tab?.id) injectContentScript(tab.id);
});

chrome.runtime.onMessage.addListener((message: TranslateRequest, sender) => {
  if (message.type !== "translate" || !sender.tab?.id) return;
  const tabId = sender.tab.id;
  const origin = sender.tab.url ? new URL(sender.tab.url).origin : "unknown";
  void handleTranslate(tabId, origin, message.segments);
});

// origin 単位の text → translation キャッシュ。sidebar 等のページ間で共通のテキストは
// 2 ページ目以降サーバを経由せず即座に挿入される
async function handleTranslate(tabId: number, origin: string, segments: Segment[]) {
  const stored = await chrome.storage.session.get(origin);
  const cache = (stored[origin] ?? {}) as Record<string, string>;

  const uncached: Segment[] = [];
  let cacheHits = 0;
  for (const s of segments) {
    const hit = cache[s.text];
    if (hit !== undefined) {
      cacheHits++;
      chrome.tabs.sendMessage(tabId, { type: "translation", seg: s.seg, translation: hit });
    } else {
      uncached.push(s);
    }
  }
  console.log(`[monica-translate] cache hits: ${cacheHits}, uncached: ${uncached.length}`);

  if (uncached.length === 0) {
    chrome.tabs.sendMessage(tabId, { type: "done" });
    return;
  }

  const textBySeg = new Map(uncached.map((s) => [s.seg, s.text]));
  const ws = new WebSocket(WS_URL);

  // MV3 service worker はアイドルで殺される。claude 起動中など無通信の間も
  // WS にトラフィックを流して worker を生かし続ける（server 側は読み捨てる）
  let keepalive: ReturnType<typeof setInterval> | undefined;
  let opened = false;
  let finished = false;

  ws.onopen = () => {
    opened = true;
    ws.send(JSON.stringify(uncached));
    keepalive = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send("ping");
      }
    }, 20000);
  };

  ws.onclose = () => {
    clearInterval(keepalive);
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === "translation") {
      const text = textBySeg.get(data.seg);
      if (text !== undefined) {
        cache[text] = data.translation;
      }
    }
    if (data.type === "error") {
      chrome.tabs.sendMessage(tabId, {
        type: "error",
        message: `翻訳に失敗しました: ${data.message}`,
      });
    } else {
      chrome.tabs.sendMessage(tabId, data);
    }

    if (data.type === "done" || data.type === "error") {
      finished = true;
      void chrome.storage.session.set({ [origin]: cache });
      ws.close();
    }
  };

  ws.onerror = () => {
    if (finished) return;
    chrome.tabs.sendMessage(tabId, {
      type: "error",
      // 接続前の失敗 = サーバ不在（Monica 未起動 or 翻訳が無効）と接続後の切断を区別する
      message: opened
        ? "翻訳サーバとの接続が切れました"
        : "Monica が起動していません（翻訳サーバに接続できません）",
    });
  };
}
