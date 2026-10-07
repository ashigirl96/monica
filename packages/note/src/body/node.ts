export type JsonNode = Record<string, unknown>

export function isNode(value: unknown): value is JsonNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function typeOf(node: unknown): unknown {
  return isNode(node) ? node.type : undefined
}

export function childrenOf(node: unknown): unknown[] {
  return isNode(node) && Array.isArray(node.content) ? node.content : []
}

export function attrOf(node: unknown, key: string): unknown {
  if (!isNode(node) || !isNode(node.attrs)) return undefined
  return node.attrs[key]
}

export function stringAttr(node: unknown, key: string): string | undefined {
  const value = attrOf(node, key)
  return typeof value === 'string' ? value : undefined
}

/** node とその子孫の text をつなげたもの。知らない node の中身を落とさないために使う。 */
export function allText(node: unknown): string {
  if (!isNode(node)) return ''
  const own = typeof node.text === 'string' ? node.text : ''
  return own + childrenOf(node).map(allText).join('')
}
