import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Page } from '../contract.ts'
import { bundledPdfReader } from './pdf.ts'
import { snapshotOf } from './snapshot.ts'
import { type TestPdfPage, testPdf } from './test-pdf.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

async function until<T>(read: () => T | undefined): Promise<T> {
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    await Bun.sleep(1)
  }
}

const pdfPage = (pages: (TestPdfPage | 'missing')[]): Page => ({
  url: 'https://coast.example/tides.pdf',
  title: 'tides.pdf',
  content: { kind: 'pdf', pdf: new File([testPdf(pages)], 'tides.pdf') },
})

test('the text of a PDF comes line by line from its Worker', async () => {
  const { content } = await snapshotOf(
    pdfPage([{ font: 'latin', lines: ['High tide comes twice a day', '(and so does low tide)'] }]),
    [],
  )

  expect(content).toEqual({
    kind: 'text',
    source: 'pdf',
    text: 'High tide comes twice a day\n(and so does low tide)',
    truncated: false,
  })
})

const JAPANESE: TestPdfPage = {
  font: 'japanese',
  lines: ['合言葉は桜餅です', '潮は一日に二度満ちる'],
}

test('the Japanese of a PDF in a CID font that it does not embed comes through the cMaps of pdf.js', async () => {
  const { content } = await snapshotOf(pdfPage([JAPANESE]), [])

  expect(content).toMatchObject({ text: '合言葉は桜餅です\n潮は一日に二度満ちる' })
})

test('without the cMaps, the Japanese of a PDF in a CID font that it does not embed is lost', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'monica-cmaps-'))
  cleanups.push(() => rmSync(empty, { recursive: true, force: true }))

  const { content } = await snapshotOf(pdfPage([JAPANESE]), [], {
    pdf: { ...bundledPdfReader(), cMaps: empty },
  })

  expect(content).toMatchObject({ kind: 'text', text: '' })
})

test('the pages of a PDF are apart by a blank line, and a page without text adds none', async () => {
  const { content } = await snapshotOf(
    pdfPage([
      { font: 'latin', lines: ['Page one', 'ends here'] },
      { font: 'latin', lines: [] },
      { font: 'latin', lines: ['Page three'] },
    ]),
    [],
  )

  expect(content).toMatchObject({ text: 'Page one\nends here\n\nPage three' })
})

// 1 ページが 60,000 字で、2 ページ目で 10 万字を超える。
const longLines = (mark: string) => Array<string>(60).fill(mark.repeat(999))
const LONG = (mark: string): TestPdfPage => ({ font: 'latin', lines: longLines(mark) })

test('a PDF longer than 100,000 characters keeps its first 100,000, is marked truncated, and its later pages are not read', async () => {
  // 3 ページ目は無い object を指し、読めば pdf.js が例外を投げる。
  const { content } = await snapshotOf(
    pdfPage([LONG('a'), LONG('b'), 'missing', { font: 'latin', lines: ['The end'] }]),
    [],
  )

  const whole = `${longLines('a').join('\n')}\n\n${longLines('b').join('\n')}`
  expect(content).toEqual({
    kind: 'text',
    source: 'pdf',
    text: whole.slice(0, 100_000),
    truncated: true,
  })
})

test('a page that pdf.js cannot open makes the PDF unparsable, with the error as the detail', async () => {
  const { content } = await snapshotOf(pdfPage([LONG('a'), 'missing']), [])

  expect(content).toEqual({
    kind: 'unreadable',
    reason: 'unparsable',
    detail: expect.stringContaining('Page dictionary'),
  })
})

test('bytes that start as a PDF but are broken are unparsable', async () => {
  const { content } = await snapshotOf(
    {
      url: 'https://coast.example/broken.pdf',
      content: { kind: 'pdf', pdf: new File(['%PDF-1.7\nnot a PDF after all'], 'broken.pdf') },
    },
    [],
  )

  expect(content).toMatchObject({ kind: 'unreadable', reason: 'unparsable' })
})

test('a PDF that takes more than 30 seconds to read is unparsable', async () => {
  const setTimeoutSpy = spyOn(globalThis, 'setTimeout')
  cleanups.push(() => setTimeoutSpy.mockRestore())

  const reading = snapshotOf(pdfPage([LONG('a')]), [])
  const limit = await until(() => setTimeoutSpy.mock.calls.find(([, ms]) => ms === 30_000))
  limit[0]()

  expect((await reading).content).toEqual({
    kind: 'unreadable',
    reason: 'unparsable',
    detail: 'reading the PDF took more than 30 seconds',
  })
})
