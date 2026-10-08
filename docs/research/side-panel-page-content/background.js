chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "ask-selection",
    title: "r258: 選択範囲を side panel へ",
    contexts: ["selection"],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  // await を挟むと user gesture が切れて sidePanel.open が拒まれる。
  chrome.sidePanel.open({ tabId: tab.id });
  chrome.storage.session.set({
    pendingSelection: { text: info.selectionText, tabId: tab.id, url: tab.url, at: Date.now() },
  });
});
