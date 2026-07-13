const WS_URL = "ws://127.0.0.1:43110/ws/translate";

interface TranslateRequest {
  type: "translate";
  segments: Array<{ seg: number; text: string }>;
}

interface TranslationMessage {
  type: "translation";
  seg: number;
  translation: string;
}

interface DoneMessage {
  type: "done";
}

interface ErrorMessage {
  type: "error";
  message: string;
}

type ServerMessage = TranslationMessage | DoneMessage | ErrorMessage;

chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) return;
  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["content.js"],
  });
});

chrome.runtime.onMessage.addListener(
  (message: TranslateRequest, sender, _sendResponse) => {
    if (message.type !== "translate" || !sender.tab?.id) return;

    const tabId = sender.tab.id;
    const ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      ws.send(JSON.stringify(message.segments));
    };

    ws.onmessage = (event) => {
      const data: ServerMessage = JSON.parse(event.data);
      chrome.tabs.sendMessage(tabId, data);

      if (data.type === "done" || data.type === "error") {
        ws.close();
      }
    };

    ws.onerror = () => {
      chrome.tabs.sendMessage(tabId, {
        type: "error",
        message: "WebSocket connection failed",
      });
    };
  },
);
