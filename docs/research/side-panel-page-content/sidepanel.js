const events = [];

function record(type, data) {
  events.push({ at: Date.now(), type, ...data });
  document.getElementById("events").textContent = events
    .slice(-30)
    .map((e) => JSON.stringify(e))
    .join("\n");
}

function show(value) {
  document.getElementById("result").textContent = JSON.stringify(value, null, 2);
  return value;
}

// executeScript は関数を文字列にして page へ送るので、外の変数を参照できない。
function snapshotPage(full) {
  const active = document.activeElement;
  const field =
    active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement
      ? active
      : null;
  const text = document.body ? document.body.innerText : "";
  return {
    href: location.href,
    title: document.title,
    readyState: document.readyState,
    contentType: document.contentType,
    isTop: window === window.top,
    innerTextLength: text.length,
    outerHTMLLength: document.documentElement.outerHTML.length,
    head: text.slice(0, 120),
    text: full ? text : undefined,
    selection: getSelection()?.toString() ?? null,
    fieldSelection:
      field && typeof field.selectionStart === "number"
        ? field.value.slice(field.selectionStart, field.selectionEnd)
        : null,
    embeds: [...document.querySelectorAll("embed, object, iframe")].map((e) => ({
      tag: e.tagName,
      type: e.getAttribute("type"),
      src: e.getAttribute("src") ?? e.getAttribute("data"),
    })),
  };
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function read({ allFrames = false, full = false, world = "ISOLATED", tabId } = {}) {
  const tab = tabId === undefined ? await getActiveTab() : await chrome.tabs.get(tabId);
  const summary = { id: tab.id, url: tab.url, title: tab.title, windowId: tab.windowId };
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames },
      func: snapshotPage,
      args: [full],
      world,
    });
    return show({
      tab: summary,
      results: results.map((r) => ({
        frameId: r.frameId,
        documentId: r.documentId,
        result: r.result,
        error: r.error,
      })),
    });
  } catch (error) {
    return show({ tab: summary, error: String(error?.message ?? error) });
  }
}

document.getElementById("read").addEventListener("click", () => read());
document
  .getElementById("read-all-frames")
  .addEventListener("click", () => read({ allFrames: true }));
document.getElementById("selection").addEventListener("click", async () => {
  const { results, error } = await read({ allFrames: true });
  show(error ?? results.map((r) => r.result?.selection || r.result?.fieldSelection));
});

chrome.tabs.onActivated.addListener((info) => record("tabs.onActivated", info));
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) =>
  record("tabs.onUpdated", { tabId, changeInfo, tabUrl: tab.url }),
);
chrome.windows.onFocusChanged.addListener((windowId) =>
  record("windows.onFocusChanged", { windowId }),
);
chrome.webNavigation.onCommitted.addListener((d) =>
  record("webNavigation.onCommitted", {
    tabId: d.tabId,
    frameId: d.frameId,
    url: d.url,
    transitionType: d.transitionType,
  }),
);
chrome.webNavigation.onHistoryStateUpdated.addListener((d) =>
  record("webNavigation.onHistoryStateUpdated", { tabId: d.tabId, frameId: d.frameId, url: d.url }),
);
chrome.webNavigation.onReferenceFragmentUpdated.addListener((d) =>
  record("webNavigation.onReferenceFragmentUpdated", { tabId: d.tabId, url: d.url }),
);
chrome.webNavigation.onCompleted.addListener((d) =>
  record("webNavigation.onCompleted", { tabId: d.tabId, frameId: d.frameId, url: d.url }),
);
chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.pendingSelection) {
    record("pendingSelection", changes.pendingSelection.newValue);
  }
});
// context menu から開いたときは、panel の読み込みより先に storage へ書かれていることがある。
chrome.storage.session.get("pendingSelection").then(({ pendingSelection }) => {
  if (pendingSelection) {
    record("pendingSelection(initial)", pendingSelection);
  }
});

globalThis.r258 = { read, getActiveTab, events };
