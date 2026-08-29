import { PluginKey } from "@milkdown/kit/prose/state";
import type { SlashState } from "./slash-menu";
import type { NoteMentionMenuState } from "./note-mention-menu";
import type { PasteMenuState } from "./paste-menu";
import type { LinkMenuState } from "./link-menu";
import type { TableMenuState } from "./table-menu";

// slash-menu と note-mention-menu は互いの active を見て二重 open を防ぐ
// （project の表示名 "owner/repo" を `[[` メニューで検索中に `/` で slash が開く等）。
// key を各 plugin ファイルに置くと相互参照が循環 import になるため、ここに集約する。
export const slashKey = new PluginKey<SlashState>("journalSlashMenu");
export const noteMentionMenuKey = new PluginKey<NoteMentionMenuState>("journalNoteMentionMenu");
// paste-menu（Paste / Paste and sync）。paste 直後にだけ開き、docChanged で自動的に閉じる。
export const pasteMenuKey = new PluginKey<PasteMenuState>("journalPasteMenu");
// table-menu（セル右クリック: 行・列の挿入 / 削除）。doc 変更・selection 移動で自動的に閉じる。
export const tableMenuKey = new PluginKey<TableMenuState>("journalTableMenu");
// link-menu（URL paste 直後の Paste as…）。table-menu は開いている間 contextmenu を譲る。
export const linkMenuKey = new PluginKey<LinkMenuState>("journalLinkMenu");
