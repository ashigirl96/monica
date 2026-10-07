export type JsonNode = Record<string, unknown>

export function isNode(value: unknown): value is JsonNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function childrenOf(node: unknown): unknown[] {
  return isNode(node) && Array.isArray(node.content) ? node.content : []
}
