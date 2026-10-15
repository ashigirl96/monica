/// <reference types="bun" />
import { expect, test } from 'bun:test'

import { columnWidths, moveColumnBorder } from './column-widths.ts'
import { nodes } from './schema.ts'
import { tableOf } from './test-fixtures.ts'

test('境界を動かすと隣の列だけが同じ分だけ縮み、ほかの列は変わらない', () => {
  expect(moveColumnBorder([0.2, 0.3, 0.5], 0, 0.1, 0.05)).toEqual([0.3, 0.2, 0.5])
})

test('隣の列は最小の幅より狭くならない', () => {
  expect(moveColumnBorder([0.2, 0.3, 0.5], 0, 0.9, 0.05)).toEqual([0.45, 0.05, 0.5])
  expect(moveColumnBorder([0.2, 0.3, 0.5], 0, -0.9, 0.05)).toEqual([0.05, 0.45, 0.5])
})

test('2 列の和が最小の幅の 2 倍に満たなければ、2 列を等分で止める', () => {
  expect(moveColumnBorder([0.04, 0.02, 0.94], 0, 0.5, 0.05)).toEqual([0.03, 0.03, 0.94])
})

test('幅の数が列数と合わない表は、幅を持たない表として描く', () => {
  const rows = tableOf([['a', 'b']]).content
  expect(columnWidths(nodes.table.create({ colWidths: [0.5, 0.5] }, rows))).toEqual([0.5, 0.5])
  expect(columnWidths(nodes.table.create({ colWidths: [0.2, 0.3, 0.5] }, rows))).toBeNull()
})
