import type { RefObject } from "react";
import { BlockEditor, type BlockEditorHandle } from "@shared/block-editor/block-editor";
import type { OnNoteMentionClick, ResolveNoteMention } from "@shared/block-editor/node-views";
import type { OnOpenBlock, ResolveBlock } from "@shared/block-editor/synced-block";
import { importImageAsset, renderNoteMarkdown, uploadImageAsset } from "@/api";
import type { Note } from "@/types.gen";
import { fetchLinkMetadata, searchNoteMentions } from "./editor-support";

/** daily / essay / project の各エディタが共有する BlockEditor の配線。link preview・mention
 * 検索・画像アップロード・markdown 投影は kind 非依存なのでここに集約し、note ごとに変わる
 * 解決子とハンドラだけを props で受ける。 */
export function NoteBlockEditor({
  note,
  autoFocus,
  onDocChange,
  onExitUp,
  onNoteMentionClick,
  resolveNoteMention,
  resolveBlock,
  onOpenBlock,
  handleRef,
}: {
  note: Note;
  autoFocus: boolean;
  onDocChange: (doc: unknown) => void;
  onExitUp?: () => void;
  onNoteMentionClick: OnNoteMentionClick;
  resolveNoteMention: ResolveNoteMention;
  resolveBlock: ResolveBlock;
  onOpenBlock: OnOpenBlock;
  handleRef: RefObject<BlockEditorHandle | null>;
}) {
  return (
    <BlockEditor
      key={note.id}
      initialDoc={note.content}
      autoFocus={autoFocus}
      onDocChange={onDocChange}
      onExitUp={onExitUp}
      fetchLinkMetadata={fetchLinkMetadata}
      searchNoteMentions={searchNoteMentions}
      resolveNoteMention={resolveNoteMention}
      onNoteMentionClick={onNoteMentionClick}
      noteId={note.id}
      resolveBlock={resolveBlock}
      onOpenBlock={onOpenBlock}
      uploadImage={uploadImageAsset}
      importExternalImage={importImageAsset}
      renderMarkdown={renderNoteMarkdown}
      handleRef={handleRef}
      className="min-h-[70dvh] pt-4 pb-24"
    />
  );
}
