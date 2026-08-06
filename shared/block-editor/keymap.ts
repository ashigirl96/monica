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
  exitDocStart,
  ignoreCompositionEnter,
  indentBlock,
  insertHardBreak,
  outdentBlock,
  splitBlock,
  toggleCollapse,
} from "./commands";
import {
  tableEnter,
  tableExit,
  tableHardBreak,
  tableLineEnd,
  tableLineStart,
  tableNextCell,
  tablePrevCell,
} from "./table";

// TODO.md §12.1 の優先順位のうち 3〜7 をここで表現する。
// 1(composition) は ProseMirror が keyCode 229 を keymap に流さないことで、
// 2(menu) と 4(block selection) は plugin 配列で keymap より前に置くことで満たす。
export function editorKeymap(): Plugin[] {
  return [
    keymap({
      // table cell 内キー → code block 内キー（§4.3）→ 通常 block の構造キー（§3・§4・§5）。
      // table を先頭に置く: 後続 command は getBlockContext 経由で「table を包む container」
      // を単位に動いてしまい、cell 内では分割・indent が表を壊す。
      Tab: chainCommands(tableNextCell, codeIndent, indentBlock),
      "Shift-Tab": chainCommands(tablePrevCell, codeOutdent, outdentBlock),
      Enter: chainCommands(ignoreCompositionEnter, tableEnter, codeNewline, splitBlock),
      // tableHardBreak は exitCallout より前: callout の子として table が nest している場合、
      // cell 内の Shift-Enter を callout 脱出に食われない
      "Shift-Enter": chainCommands(codeNewline, tableHardBreak, exitCallout, insertHardBreak),
      "Mod-Enter": chainCommands(tableExit, exitCodeBlock),
      // 複数 block をまたぐ text selection は prosemirror-view が native 削除を
      // 抑止する（stopNativeHorizontalDelete）ため、deleteSelection で明示的に消す
      Backspace: chainCommands(undoInputRule, deleteSelection, backspaceBlock),
      Delete: chainCommands(deleteSelection, deleteForwardBlock),
      // macOS 流のカーソル移動
      "Ctrl-a": chainCommands(tableLineStart, cursorToLineStart),
      "Ctrl-e": chainCommands(tableLineEnd, cursorToLineEnd),
      // 空行のみ行ごと削除。非空行は false でネイティブの前方 1 文字削除に落とす
      "Ctrl-d": deleteEmptyBlock,
      // ↓と同義だが、最下 block から先へ進めないときだけ末尾に空行を確保する
      "Ctrl-n": exitDocEnd,
      // ↑と同義だが、最上 block から先へ進めないときだけ先頭に空行を確保する。
      // onExitUp 付き editor（essays 等）は手前の keymap がタイトルへの脱出を優先する
      "Ctrl-p": exitDocStart,
      // heading / callout / toggle の折りたたみ。macOS の ⌥. は "≥" を生むが、
      // prosemirror-keymap が keyCode から base key を解決するのでこの binding で届く
      "Alt-.": toggleCollapse,
      // inline formatting
      "Mod-b": toggleMark(schema.marks.bold),
      "Mod-i": toggleMark(schema.marks.italic),
      "Mod-u": toggleMark(schema.marks.underline),
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
