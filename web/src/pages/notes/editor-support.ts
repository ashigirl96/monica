import { type RefObject, useCallback, useRef } from "react";
import type { BlockEditorHandle } from "@shared/block-editor/block-editor";
import { stripPendingImages } from "@shared/block-editor/image-upload";
import type { LinkMetadata } from "@shared/block-editor/link-menu";
import type { NoteMentionItem } from "@shared/block-editor/note-mention-menu";
import type { NoteMentionInfo } from "@shared/block-editor/node-views";
import {
  fetchLinkPreview,
  getNoteBlock,
  resolveNoteMention as resolveNoteMentionApi,
  searchNoteMentions as searchNoteMentionsApi,
} from "@/api";
import type { Note } from "@/types.gen";
import { setPendingBlockTarget } from "./block-jump";

export async function fetchLinkMetadata(url: string): Promise<LinkMetadata | null> {
  const preview = await fetchLinkPreview(url);
  if (!preview) return null;
  return {
    title: preview.title,
    description: preview.description,
    image: preview.image,
    favicon: preview.favicon,
    siteName: preview.site_name,
  };
}

export async function searchNoteMentions(query: string): Promise<NoteMentionItem[]> {
  const mentions = await searchNoteMentionsApi(query);
  return mentions.map((m) => ({ id: m.id, displayName: m.display_name, preview: m.preview }));
}

// autosave が保存する content から、アップロード未完了（src:null）の image block を除く。
// toJSON を持つ live doc（PMNode）はフラッシュ時（JSON.stringify）に一度だけ walk するよう
// 遅延ラップし、打鍵毎の全文 walk を避ける。src:null を保存すると再読込で復元不能になる。
export function persistableContent(content: unknown): unknown {
  return {
    toJSON: () => {
      const hasToJson = !!content && typeof (content as { toJSON?: unknown }).toJSON === "function";
      const json = hasToJson ? (content as { toJSON: () => unknown }).toJSON() : content;
      return stripPendingImages(json);
    },
  };
}

/** mention / synced block の解決とジャンプ。notes / daily 両エディタで共有する配線 */
export function useNoteBlockResolvers({
  flush,
  noteRef,
  editorHandleRef,
  onNavigateToNote,
}: {
  flush: () => Promise<void>;
  noteRef: RefObject<Note | null>;
  editorHandleRef: RefObject<BlockEditorHandle | null>;
  onNavigateToNote: (noteId: string) => void;
}) {
  // 同一 doc 内の重複 mention を 1 リクエストに畳む Promise 共有キャッシュ。
  // 開くノートが変わるたび呼び手が捨てるので、開き直しで表示名が最新タイトルに追従する
  const mentionCacheRef = useRef(new Map<string, Promise<NoteMentionInfo | null>>());

  const resolveNoteMention = useCallback((noteId: string): Promise<NoteMentionInfo | null> => {
    const cache = mentionCacheRef.current;
    let promise = cache.get(noteId);
    if (!promise) {
      promise = resolveNoteMentionApi(noteId).then((m) =>
        m ? { displayName: m.display_name } : null,
      );
      cache.set(noteId, promise);
    }
    return promise;
  }, []);

  // synced block（transclusion）の内容解決。キャッシュしないのは、通信エラー時に retry で
  // 再フェッチさせるため（NodeView が reject を error 状態として扱う）。
  // 別ノート参照は HTTP で解決するので、直前の編集が debounce 中／in-flight だと stale を読む。
  // ノート切替は flush を await せず navigate するため、pending PUT の完了を待ってから GET する
  // （cross-note ミラーは一度しか解決しないので stale がそのまま残る）。
  const resolveBlock = useCallback(
    async (noteId: string, blockId: string): Promise<unknown | null> => {
      await flush();
      const r = await getNoteBlock(noteId, blockId);
      return r?.block ?? null;
    },
    [flush],
  );

  // synced block のジャンプ。同一ノートなら直接スクロール、別ノートなら navigate 後に
  // 再マウントを跨いで対象を運ぶ。
  const onOpenBlock = useCallback(
    (targetNoteId: string, blockId: string) => {
      if (targetNoteId === noteRef.current?.id) {
        editorHandleRef.current?.scrollToBlock(blockId);
        return;
      }
      setPendingBlockTarget({ noteId: targetNoteId, blockId });
      onNavigateToNote(targetNoteId);
    },
    [noteRef, editorHandleRef, onNavigateToNote],
  );

  return { mentionCacheRef, resolveNoteMention, resolveBlock, onOpenBlock };
}
