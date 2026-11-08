// 空白は Unicode の White_Space で判定する。JS の trim と \s は U+FEFF を空白に数え、U+0085 を数えない。
const SPACE = /\p{White_Space}/u

export function isSpace(char: string | undefined): boolean {
  return char !== undefined && SPACE.test(char)
}

export function isAsciiPunctuation(char: string): boolean {
  const code = char.charCodeAt(0)
  return (
    (code >= 0x21 && code <= 0x2f) ||
    (code >= 0x3a && code <= 0x40) ||
    (code >= 0x5b && code <= 0x60) ||
    (code >= 0x7b && code <= 0x7e)
  )
}

export function isAlphanumeric(char: string): boolean {
  return /^[\p{Alphabetic}\p{N}]$/u.test(char)
}

/** 空白（U+0020）で始まって終わり、空白だけではない。CommonMark はこの形の code span の中身から両端の空白を 1 つずつ外す。 */
export function isSpacePadded(text: string): boolean {
  return text.startsWith(' ') && text.endsWith(' ') && /[^ ]/.test(text)
}

export function hasSpace(text: string): boolean {
  return SPACE.test(text)
}

export function trimEnd(text: string): string {
  let end = text.length
  while (end > 0 && isSpace(text[end - 1])) end--
  return text.slice(0, end)
}

export function trim(text: string): string {
  const end = trimEnd(text)
  let start = 0
  while (start < end.length && isSpace(end[start])) start++
  return end.slice(start)
}

/** 末尾の改行は行を作らず、`\r` は `\n` の前にあるときだけ外す。 */
export function lines(text: string): string[] {
  const parts = text.split('\n')
  const last = parts.pop() ?? ''
  const out = parts.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
  if (last !== '') out.push(last)
  return out
}
