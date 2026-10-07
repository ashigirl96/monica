import { childrenOf, isNode, type JsonNode } from './node.ts'

export type Block = JsonNode & { type: 'blockContainer' }

/** 入れ子の block ごと、保存された形のまま返す。 */
export function blockById(node: unknown, blockId: string): Block | null {
  if (!isNode(node)) return null
  if (node.type === 'blockContainer' && isNode(node.attrs) && node.attrs.id === blockId) {
    return node as Block
  }
  for (const child of childrenOf(node)) {
    const found = blockById(child, blockId)
    if (found !== null) return found
  }
  return null
}
