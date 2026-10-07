import { IMAGE_URL_PREFIX } from '../contract.ts'

// node の形が変わっても参照を落とさないよう、node の型を問わず文字列の値をすべて見る。
export function imageReferences(doc: unknown): string[] {
  if (typeof doc === 'string') {
    return doc.startsWith(IMAGE_URL_PREFIX) ? [doc.slice(IMAGE_URL_PREFIX.length)] : []
  }
  if (doc === null || typeof doc !== 'object') return []
  return Object.values(doc).flatMap(imageReferences)
}
