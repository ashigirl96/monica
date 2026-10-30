// shortcut: covers CJK, Hangul and fullwidth forms only; emoji count as one cell.
const isWide = (cp: number) =>
  (cp >= 0x1100 && cp <= 0x115f) ||
  (cp >= 0x2e80 && cp <= 0xa4cf) ||
  (cp >= 0xac00 && cp <= 0xd7a3) ||
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0xfe30 && cp <= 0xfe4f) ||
  (cp >= 0xff00 && cp <= 0xff60) ||
  (cp >= 0xffe0 && cp <= 0xffe6)

export const cells = (s: string) => {
  let n = 0
  for (const ch of s) n += isWide(ch.codePointAt(0) ?? 0) ? 2 : 1

  return n
}

const NO_LINE_START = new Set('、。，．・：；？！）」』】〕ー')

// An ASCII word stays whole; every other character may break on either side.
const tokens = (s: string) => s.match(/[\x21-\x7e]+| +|[^\x20-\x7e]/gu) ?? []

const wrapParagraph = (text: string, width: number): string[] => {
  const lines: string[] = []
  let line: string[] = []
  let used = 0
  const flush = () => {
    lines.push(line.join('').trimEnd())
    line = []
    used = 0
  }
  for (const tok of tokens(text)) {
    const w = cells(tok)
    if (used > 0 && used + w > width) {
      if (tok.trim() === '') {
        flush()
        continue
      }
      const carried = NO_LINE_START.has(tok) && line.length > 1 ? line.pop() : undefined
      flush()
      if (carried !== undefined) {
        line.push(carried)
        used = cells(carried)
      }
    }
    if (used === 0 && tok.trim() === '') continue
    if (w > width) {
      for (const ch of tok) {
        if (used + 1 > width) flush()
        line.push(ch)
        used += 1
      }
      continue
    }
    line.push(tok)
    used += w
  }
  if (line.length > 0) flush()

  return lines
}

export const wrap = (text: string, width: number): string[] =>
  text.split('\n').flatMap((p) => wrapParagraph(p, Math.max(width, 4)))

export const fit = (text: string, width: number): string => {
  if (cells(text) <= width) return text
  let out = ''
  for (const ch of text) {
    if (cells(out + ch) > width - 1) break
    out += ch
  }

  return `${out}…`
}
