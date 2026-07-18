import { PluginKey } from "@milkdown/kit/prose/state";
import type { SlashState } from "./slash-menu";
import type { NoteMentionMenuState } from "./note-mention-menu";
import type { PasteMenuState } from "./paste-menu";

// slash-menu と note-mention-menu は互いの active を見て二重 open を防ぐ
// （project の表示名 "owner/repo" を `[[` メニューで検索中に `/` で slash が開く等）。
// key を各 plugin ファイルに置くと相互参照が循環 import になるため、ここに集約する。
export const slashKey = new PluginKey<SlashState>("journalSlashMenu");
export const noteMentionMenuKey = new PluginKey<NoteMentionMenuState>("journalNoteMentionMenu");
// paste-menu（Paste / Paste and sync）。paste 直後にだけ開き、docChanged で自動的に閉じる。
export const pasteMenuKey = new PluginKey<PasteMenuState>("journalPasteMenu");
