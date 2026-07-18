import { keymap } from "@milkdown/kit/prose/keymap";
import { chainCommands, deleteSelection, toggleMark } from "@milkdown/kit/prose/commands";
import { undoInputRule } from "@milkdown/kit/prose/inputrules";
import { history, redo, undo } from "@milkdown/kit/prose/history";
import type { Plugin } from "@milkdown/kit/prose/state";
import { schema } from "./schema";
import {
  backspaceBlock,
  codeIndent,
  codeNewline,
  codeOutdent,
  cursorToLineEnd,
  cursorToLineStart,
  deleteEmptyBlock,
  deleteForwardBlock,
  exitCallout,
  exitCodeBlock,
  exitDocEnd,
  ignoreCompositionEnter,
  indentBlock,
  insertHardBreak,
  outdentBlock,
  splitBlock,
} from "./commands";

// TODO.md §12.1 の優先順位のうち 3〜7 をここで表現する。
// 1(composition) は ProseMirror が keyCode 229 を keymap に流さないことで、
// 2(menu) と 4(block selection) は plugin 配列で keymap より前に置くことで満たす。
export function editorKeymap(): Plugin[] {
  return [
    keymap({
      // code block 内キー（§4.3）→ 通常 block の構造キー（§3・§4・§5）
      Tab: chainCommands(codeIndent, indentBlock),
      "Shift-Tab": chainCommands(codeOutdent, outdentBlock),
      Enter: chainCommands(ignoreCompositionEnter, codeNewline, splitBlock),
      "Shift-Enter": chainCommands(codeNewline, exitCallout, insertHardBreak),
      "Mod-Enter": exitCodeBlock,
      // 複数 block をまたぐ text selection は prosemirror-view が native 削除を
      // 抑止する（stopNativeHorizontalDelete）ため、deleteSelection で明示的に消す
      Backspace: chainCommands(undoInputRule, deleteSelection, backspaceBlock),
      Delete: chainCommands(deleteSelection, deleteForwardBlock),
      // macOS 流のカーソル移動
      "Ctrl-a": cursorToLineStart,
      "Ctrl-e": cursorToLineEnd,
      // 空行のみ行ごと削除。非空行は false でネイティブの前方 1 文字削除に落とす
      "Ctrl-d": deleteEmptyBlock,
      // ↓と同義だが、最下 block から先へ進めないときだけ末尾に空行を確保する
      "Ctrl-n": exitDocEnd,
      // inline formatting
      "Mod-b": toggleMark(schema.marks.bold),
      "Mod-i": toggleMark(schema.marks.italic),
      "Mod-e": toggleMark(schema.marks.code),
      "Mod-Shift-s": toggleMark(schema.marks.strike),
      // history
      "Mod-z": undo,
      "Shift-Mod-z": redo,
      "Mod-y": redo,
    }),
    history(),
  ];
}
