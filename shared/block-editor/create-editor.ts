import { keymap } from "@milkdown/kit/prose/keymap";
import { EditorState } from "@milkdown/kit/prose/state";
import { EditorView } from "@milkdown/kit/prose/view";
import { Node as PMNode } from "@milkdown/kit/prose/model";
import { emptyDoc, schema } from "./schema";
import { editorKeymap } from "./keymap";
import { editorInputRules } from "./input-rules";
import { blockSelectionPlugin } from "./block-selection";
import { slashMenuPlugin } from "./slash-menu";
import { linkMenuPlugin } from "./link-menu";
import type { FetchLinkMetadata } from "./link-menu";
import { noteMentionMenuPlugin } from "./note-mention-menu";
import type { SearchNoteMentions } from "./note-mention-menu";
import { pasteMenuPlugin } from "./paste-menu";
import { imageUploadPlugin } from "./image-upload";
import type { ImportExternalImage, UploadImage } from "./image-upload";
import type { OnNoteMentionClick, ResolveNoteMention } from "./node-views";
import { normalizerPlugin } from "./normalizer";
import { numberingPlugin, placeholderPlugin } from "./decorations";
import { dragDropPlugin } from "./drag-drop";
import { clipboardPlugin } from "./clipboard";
import { linkClickPlugin } from "./link-click";
import { editorNodeViews } from "./node-views";
import { SyncedBlockView, syncedBlockRefreshPlugin } from "./synced-block";
import type { OnOpenBlock, ResolveBlock } from "./synced-block";
import { blockHighlightPlugin } from "./block-highlight";
import { imeDebugPlugin } from "./debug-ime";

function docFromJSON(json: unknown): PMNode {
  if (json === null || json === undefined) return emptyDoc();
  try {
    const doc = PMNode.fromJSON(schema, json);
    // fromJSON は content 制約を検証しない。空 doc（{"type":"doc","content":[]} 等）を
    // そのまま返すとプラグインが壊れるので、schema 違反はここで弾く。
    doc.check();
    return doc;
  } catch {
    return emptyDoc();
  }
}

/** カーソルが doc 先頭の textblock 内にあるか */
function inFirstTextblock(state: EditorState): boolean {
  let firstPos = -1;
  let firstSize = 0;
  state.doc.descendants((node, pos) => {
    if (firstPos !== -1) return false;
    if (node.isTextblock) {
      firstPos = pos;
      firstSize = node.nodeSize;
      return false;
    }
    return true;
  });
  if (firstPos === -1) return false;
  const head = state.selection.$head.pos;
  return head >= firstPos && head <= firstPos + firstSize;
}

export type BlockEditorCallbacks = {
  onDocChange?: (doc: unknown) => void;
  /** 文書先頭の block で ↑（最上行）/ Shift-Tab（outdent 不能時）が押されたとき
      （タイトル等、エディタ外への上方向フォーカス移動用） */
  onExitUp?: () => void;
  /** URL ペースト時の Mention/Bookmark 用メタデータ取得。
      未指定なら 3 択メニューは出ず、常にプレーンリンクになる */
  fetchLinkMetadata?: FetchLinkMetadata;
  /** `[[` メニューのノート検索。未指定なら wiki link メニューと
      内部 URL paste の自動 mention 化が無効になる */
  searchNoteMentions?: SearchNoteMentions;
  /** noteMention チップの表示名解決。未指定なら noteId のまま表示 */
  resolveNoteMention?: ResolveNoteMention;
  /** noteMention チップの素クリック（SPA 遷移用） */
  onNoteMentionClick?: OnNoteMentionClick;
  /** 現在編集中の note の id。synced block の同一ノート内参照を live doc から解決する。 */
  noteId?: string;
  /** synced block（transclusion）の内容解決。未指定なら paste-and-sync は無効。 */
  resolveBlock?: ResolveBlock;
  /** synced block のジャンプ（元ブロックを開く）。 */
  onOpenBlock?: OnOpenBlock;
  /** 画像 File を asset にアップロードする。未指定なら画像 paste / drop は無効（desktop 縮退）。 */
  uploadImage?: UploadImage;
  /** 外部画像 URL をローカル asset 化する（外部 HTML paste の <img> 用）。 */
  importExternalImage?: ImportExternalImage;
};

export function createBlockEditor(
  mount: HTMLElement,
  initialDoc: unknown,
  {
    onDocChange,
    onExitUp,
    fetchLinkMetadata,
    searchNoteMentions,
    resolveNoteMention,
    onNoteMentionClick,
    noteId,
    resolveBlock,
    onOpenBlock,
    uploadImage,
    importExternalImage,
  }: BlockEditorCallbacks = {},
): EditorView {
  // synced block の NodeView 群を refresh plugin と共有する（同一ノート内のライブ反映用）
  const syncedRegistry = new Set<SyncedBlockView>();
  const state = EditorState.create({
    doc: docFromJSON(initialDoc),
    // TODO.md §12.1: menu → block selection → 構造キー → inline → default の順
    plugins: [
      // 全 keystroke の logging + 全文 walk を伴うため dev 限定
      ...(import.meta.env.DEV ? [imeDebugPlugin()] : []),
      slashMenuPlugin(),
      // plugin 不在なら clipboard の open meta は無視され、常にプレーンリンクに落ちる
      ...(fetchLinkMetadata ? [linkMenuPlugin(fetchLinkMetadata)] : []),
      ...(searchNoteMentions ? [noteMentionMenuPlugin(searchNoteMentions)] : []),
      // block selection より前: paste 直後は選択が残っており、後ろに置くと Escape/Enter/↑↓
      // が block-selection の handleKeyDown に食われる。plugin 不在なら openPasteMenu meta は
      // 無視され plain paste に落ちる。
      ...(resolveBlock ? [pasteMenuPlugin()] : []),
      blockSelectionPlugin(),
      // editorKeymap の Shift-Tab（structureCommand）は outdent 不能でも true を返す（KEY-003）
      // ため、先頭 block での上方向脱出はその手前で拾う必要がある
      ...(onExitUp
        ? [
            (() => {
              // ↑ と Ctrl-p は同じ「最上行なら脱出、それ以外は通常のカーソル移動」
              const exitIfTopLine: Parameters<typeof keymap>[0][string] = (s, _dispatch, view) => {
                if (!view || !s.selection.empty) return false;
                if (!view.endOfTextblock("up") || !inFirstTextblock(s)) return false;
                onExitUp();
                return true;
              };
              return keymap({
                ArrowUp: exitIfTopLine,
                "Ctrl-p": exitIfTopLine,
                "Shift-Tab": (s) => {
                  if (!s.selection.empty || !inFirstTextblock(s)) return false;
                  // 先頭が codeBlock のときはコードの outdent を優先する
                  if (s.selection.$head.parent.type.name === "codeBlock") return false;
                  onExitUp();
                  return true;
                },
              });
            })(),
          ]
        : []),
      ...editorKeymap(),
      editorInputRules(),
      placeholderPlugin(),
      numberingPlugin(),
      blockHighlightPlugin(),
      dragDropPlugin(),
      // clipboardPlugin より前に置く: 画像ファイルの paste / drop を URL・block paste 経路より
      // 先に横取りする。uploadImage 不在（desktop journal）なら plugin ごと外れて画像 paste は無効。
      ...(uploadImage
        ? [imageUploadPlugin({ upload: uploadImage, importExternal: importExternalImage })]
        : []),
      clipboardPlugin({ sourceNoteId: noteId, syncPasteEnabled: !!resolveBlock }),
      linkClickPlugin(),
      syncedBlockRefreshPlugin(syncedRegistry),
      normalizerPlugin(),
    ],
  });
  const view = new EditorView(mount, {
    state,
    nodeViews: editorNodeViews(
      { resolveNoteMention, onNoteMentionClick, noteId, resolveBlock, onOpenBlock },
      syncedRegistry,
    ),
    attributes: { class: "jb-editor", spellcheck: "false" },
    dispatchTransaction(tr) {
      view.updateState(view.state.apply(tr));
      // toJSON は全文 walk なので打鍵毎には行わない。doc は immutable な node なので
      // 受け手が保持して flush 時に JSON.stringify（= toJSON）すればよい
      if (tr.docChanged) onDocChange?.(view.state.doc);
    },
  });
  return view;
}
