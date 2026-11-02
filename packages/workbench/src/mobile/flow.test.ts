import { expect, test } from 'bun:test'

import { Terminal } from '@xterm/xterm'

import { renderFlow } from './flow.ts'

async function written(cols: number, data: string) {
  const term = new Terminal({ cols, rows: 4, allowProposedApi: true })
  await new Promise<void>((resolve) => term.write(data, resolve))
  return term
}

test('flow joins rows the Mac soft-wrapped, keeps hard newlines, colors and the cursor, and escapes markup', async () => {
  const term = await written(10, 'abcde fghij klm\r\n\x1b[31m<x>\x1b[0m & y   \r\n$ ')
  const html = renderFlow(term.buffer.active)
  expect(html).toBe(
    '<div>abcde fghij klm</div>' +
      '<div><span style="color:#cc0000">&lt;x&gt;</span> &amp; y</div>' +
      '<div>$ <span class="flow-cursor"> </span></div>',
  )
  term.dispose()
})

test('flow ends at the cursor or the last written row, whichever is lower, and drops blank rows below', async () => {
  const term = await written(10, 'one\r\n\x1b[4;1Hlast\x1b[2;1H')
  expect(renderFlow(term.buffer.active)).toBe(
    '<div>one</div><div><span class="flow-cursor"> </span></div><div></div><div>last</div>',
  )
  const cleared = await written(10, 'one\r\n')
  expect(renderFlow(cleared.buffer.active)).toBe(
    '<div>one</div><div><span class="flow-cursor"> </span></div>',
  )
  term.dispose()
  cleared.dispose()
})
