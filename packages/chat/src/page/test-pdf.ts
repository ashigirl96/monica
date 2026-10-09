/** テストの PDF の 1 ページ。latin は ASCII だけ、japanese は BMP の字だけを書ける。 */
export type TestPdfPage = { font: 'latin' | 'japanese'; lines: string[] }

const literal = (text: string) => `(${text.replace(/[\\()]/g, (c) => `\\${c}`)})`

// UniJIS-UCS2-H は UCS-2 の 2 byte をそのまま CID に引く。
const ucs2 = (text: string) =>
  `<${Array.from({ length: text.length }, (_, i) => text.charCodeAt(i).toString(16).padStart(4, '0')).join('')}>`

/**
 * テストの PDF の bytes を組む。binary の file を repo に置かないため。
 * latin は埋め込まない Helvetica、japanese は埋め込まない HeiseiKakuGo-W5 と UniJIS-UCS2-H で、cMap が無いと日本語が落ちる。
 * missing のページは無い object を指し、開くと pdf.js が例外を投げる。
 */
export function testPdf(pages: (TestPdfPage | 'missing')[]): Uint8Array<ArrayBuffer> {
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /HeiseiKakuGo-W5 /Encoding /UniJIS-UCS2-H /DescendantFonts [5 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HeiseiKakuGo-W5 /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 2 >> /FontDescriptor 6 0 R /DW 1000 >>',
    '<< /Type /FontDescriptor /FontName /HeiseiKakuGo-W5 /Flags 4 /FontBBox [-92 -250 1010 922] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 737 /StemV 69 >>',
  ]
  const kids: number[] = []
  for (const page of pages) {
    if (page === 'missing') {
      kids.push(objects.length + 1000)
      continue
    }
    const [font, show] = page.font === 'latin' ? ['/F1', literal] : ['/F2', ucs2]
    // pdf.js はページの外の字を本文に入れないので、長い行と多い行が収まるまでページを広げる。字の幅は 12pt を超えない。
    const width = Math.max(595, 144 + 12 * Math.max(0, ...page.lines.map((line) => line.length)))
    const height = Math.max(842, 144 + 14 * page.lines.length)
    const stream = `BT ${font} 12 Tf 14 TL 72 ${height - 72} Td ${page.lines.map((line) => `${show(line)} Tj T*`).join(' ')} ET`
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${objects.length} 0 R >>`,
    )
    kids.push(objects.length)
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map((n) => `${n} 0 R`).join(' ')}] /Count ${kids.length} >>`

  let body = '%PDF-1.4\n'
  const offsets = objects.map((object, i) => {
    const offset = body.length
    body += `${i + 1} 0 obj\n${object}\nendobj\n`
    return offset
  })
  const xref = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  body += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(body)
}
