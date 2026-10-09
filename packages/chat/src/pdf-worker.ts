import { getDocument } from 'pdfjs-dist'
import * as pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs'

import type { PdfRequest } from './page/pdf.ts'
import { replyWithText } from './page/worker.ts'

// Bun では pdf.js が main thread の fake worker で動き、./pdf.worker.mjs を動的に import する。compile した binary ではその import が解けない。
Object.assign(globalThis, { pdfjsWorker })

async function textOf({ bytes, cMaps, maxChars }: PdfRequest): Promise<string> {
  // 日本語の CID font の PDF は cMap が無いと文字が空になる。
  const pdf = await getDocument({
    data: new Uint8Array(bytes),
    cMapUrl: cMaps.endsWith('/') ? cMaps : `${cMaps}/`,
    cMapPacked: true,
    verbosity: 0,
  }).promise
  let text = ''
  // 上限を超えたら残りのページは読まない。上限ちょうどなら、続きがあるかを次のページで確かめる。
  for (let n = 1; n <= pdf.numPages && text.length <= maxChars; n++) {
    const { items } = await (await pdf.getPage(n)).getTextContent()
    const page = items
      .map((item) => ('str' in item ? `${item.str}${item.hasEOL ? '\n' : ''}` : ''))
      .join('')
      .trimEnd()
    if (page === '') continue
    text = text === '' ? page : `${text}\n\n${page}`
  }
  return text
}

replyWithText(textOf)
