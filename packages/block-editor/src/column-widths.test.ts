/// <reference types="bun" />
import { describe, expect, test } from 'bun:test'

import { moveColumnBorder } from './column-widths.ts'
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

// synced block の写しは NodeView を通らず、schema の toDOM で描く
describe('toDOM', () => {
  const rows = tableOf([['a', 'b']]).content
  const render = (colWidths: number[] | null) =>
    nodes.table.spec.toDOM?.(nodes.table.create({ colWidths }, rows))

  test('幅を持つ表は colgroup に列の幅を描き、fixed layout にする', () => {
    expect(render([0.2, 0.8])).toEqual([
      'table',
      { 'data-block-content': 'table', class: 'jb-table-sized' },
      ['colgroup', ['col', { style: 'width: 20%' }], ['col', { style: 'width: 80%' }]],
      ['tbody', 0],
    ])
  })

  test.each([
    ['幅を持たない', null],
    ['幅の数が列数と合わない', [0.2, 0.3, 0.5]],
  ])('%s表は、列の幅を描かずに auto layout にする', (_name, colWidths) => {
    expect(render(colWidths)).toEqual([
      'table',
      { 'data-block-content': 'table', class: null },
      ['colgroup'],
      ['tbody', 0],
    ])
  })
})
