// 空白は Unicode の White_Space で判定する。JS の trim と \s は U+FEFF を空白に数え、U+0085 を数えない。
const SPACE = /\p{White_Space}/u

export function isSpace(char: string | undefined): boolean {
  return char !== undefined && SPACE.test(char)
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
