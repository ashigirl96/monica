import type { Doc } from '../../contract.ts'
import { stripPendingImages } from '../editor/image-upload.ts'

// autosave が保存する content から、アップロード未完了（src:null）の image block を除く。
// toJSON を持つ live doc（PMNode）はフラッシュ時に一度だけ walk するよう
// 遅延ラップし、打鍵毎の全文 walk を避ける。src:null を保存すると再読込で復元不能になる。
export function persistableContent(content: unknown): { toJSON: () => Doc } {
  return {
    toJSON: () => {
      const hasToJson = !!content && typeof (content as { toJSON?: unknown }).toJSON === 'function'
      const json = hasToJson ? (content as { toJSON: () => unknown }).toJSON() : content
      return stripPendingImages(json) as Doc
    },
  }
}

/** ⌥K/J の巡回選択。current がリスト外（未選択・巡回対象外の項目を開いている等）の
 * ときは「リスト先頭の外側」扱い: 前進(+1)で先頭、後退(-1)で末尾へ。空リストは undefined。 */
export function cycleSelect(
  list: string[],
  current: string | null,
  step: 1 | -1,
): string | undefined {
  if (list.length === 0) return undefined
  const found = current === null ? -1 : list.indexOf(current)
  const idx = found === -1 ? (step === 1 ? -1 : 0) : found
  return list[(idx + step + list.length) % list.length]
}
