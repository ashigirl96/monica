import { stripPendingImages } from "@shared/block-editor/image-upload";
import type { LinkMetadata } from "@shared/block-editor/link-menu";
import type { NoteMentionItem } from "@shared/block-editor/note-mention-menu";
import { fetchLinkPreview, searchNoteMentions as searchNoteMentionsApi } from "@/api";

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
