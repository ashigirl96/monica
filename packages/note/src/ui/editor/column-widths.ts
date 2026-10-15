import type { Node as PMNode } from 'prosemirror-model'

import { tableWidth } from './table.ts'

// 列の幅は表の幅に対する比（合計 1）で持ち、表は常に本文の幅に収める。

/** colWidths が今の列数と合うときだけ返す。行・列の編集で合わなくなった幅は使わない。 */
export function columnWidths(table: PMNode): number[] | null {
  const widths: unknown = table.attrs.colWidths
  if (!Array.isArray(widths) || widths.length !== tableWidth(table)) return null
  return widths.every((w) => typeof w === 'number' && w > 0) ? (widths as number[]) : null
}

/** delta と min は表の幅に対する比。 */
export function moveColumnBorder(
  widths: number[],
  col: number,
  delta: number,
  min: number,
): number[] {
  const left = widths[col]
  const right = widths[col + 1]
  if (left === undefined || right === undefined) return widths
  const pair = left + right
  const floor = Math.min(min, pair / 2)
  const next = Math.min(Math.max(left + delta, floor), pair - floor)
  const out = widths.slice()
  out[col] = round(next)
  out[col + 1] = round(pair - next)
  return out
}

export function insertColumnWidth(widths: number[], at: number): number[] {
  const n = widths.length
  const out = widths.map((w) => round((w * n) / (n + 1)))
  out.splice(at, 0, round(1 / (n + 1)))
  return out
}

export function removeColumnWidth(widths: number[], col: number): number[] {
  const rest = widths.filter((_, i) => i !== col)
  const sum = rest.reduce((a, b) => a + b, 0)
  return rest.map((w) => round(w / sum))
}

// 本文の JSON を短く保つ。1/10000 の差は画面の 1px に満たない。
export function round(w: number): number {
  return Math.round(w * 10000) / 10000
}
