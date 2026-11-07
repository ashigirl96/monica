#!/usr/bin/env bun
// Removes ADR citations in brackets from the named files in place; with no files, runs its own checks.
const adr = String.raw`ADR-\d{4}(?:・\d{4})*`

export function strip(text: string): string {
  return text
    .replace(new RegExp(`（${adr}(?:、${adr})*）`, 'g'), '')
    .replace(new RegExp(` ?\\(${adr}\\)`, 'g'), '')
    .replace(new RegExp(`[、。]${adr}(?=）)`, 'g'), '')
    .replace(new RegExp(`（${adr}、`, 'g'), '（')
}

const files = Bun.argv.slice(2)

if (files.length === 0) {
  const cases: [string, string][] = [
    ['ptyd に送る（ADR-0015）。', 'ptyd に送る。'],
    ['二つ（ADR-0009、ADR-0015）。', '二つ。'],
    ['束ねた（ADR-0016・0018）。', '束ねた。'],
    ['/// Process (ADR-0040), or', '/// Process, or'],
    ['（`keys.ts`、ADR-0041・0043）', '（`keys.ts`）'],
    ['（同じ呼び方。ADR-0034）', '（同じ呼び方）'],
    ['（ADR-0037、`packages/usage/src`）', '（`packages/usage/src`）'],
    ['ADR-0016 にある。', 'ADR-0016 にある。'],
  ]
  for (const [input, want] of cases) {
    const got = strip(input)
    if (got !== want) throw new Error(`strip(${input}) = ${got}, want ${want}`)
  }
  console.log('ok')
} else {
  for (const file of files) await Bun.write(file, strip(await Bun.file(file).text()))
}
