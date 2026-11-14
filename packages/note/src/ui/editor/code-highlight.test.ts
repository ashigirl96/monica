/// <reference types="bun" />
import { expect, test } from 'bun:test'

import { codeTokens } from './code-highlight.ts'
import { nodes, schema } from './schema.ts'

const codeIn = (language: string, text: string) =>
  nodes.codeBlock.create({ language }, schema.text(text))

const classAt = (language: string, text: string, word: string) =>
  codeTokens(codeIn(language, text)).find((token) => text.slice(token.from, token.to) === word)
    ?.className

test('選んだ言語の文法で token に highlight.js の class を付ける', () => {
  expect(classAt('typescript', 'const n: number = 1', 'const')).toBe('hljs-keyword')
  expect(classAt('typescript', 'const n: number = 1', '1')).toBe('hljs-number')
  expect(classAt('rust', 'fn main() {}', 'fn')).toBe('hljs-keyword')
})

test('shell は prompt の無い script として読み、toml と html は別名で引く', () => {
  expect(classAt('shell', 'echo "hi"', 'echo')).toBe('hljs-built_in')
  expect(classAt('toml', '[a]', '[a]')).toBe('hljs-section')
  expect(classAt('html', '<div></div>', 'div')).toBe('hljs-tag hljs-name')
})

test('plain text と mermaid には何も付けない', () => {
  expect(codeTokens(codeIn('plain text', 'const x = 1'))).toEqual([])
  expect(codeTokens(codeIn('mermaid', 'graph TD; a-->b'))).toEqual([])
})
