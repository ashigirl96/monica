import { describe, expect, test } from 'bun:test'

import { renderMermaid } from './mermaid.ts'

async function svgOf(source: string): Promise<string> {
  const result = await renderMermaid(source)
  if (!('svg' in result)) throw new Error(`expected svg, got: ${result.error}`)
  return result.svg
}

describe('renderMermaid', () => {
  test('draws a flowchart with Japanese labels as SVG', async () => {
    const svg = await svgOf('graph TD\n  A[開始] --> B[終了]')
    expect(svg).toStartWith('<svg')
    expect(svg).toContain('開始')
    expect(svg).toContain('終了')
  })

  test('breaks a label at <br/> into two lines', async () => {
    const svg = await svgOf('graph TD\n  A[一行目<br/>二行目]')
    expect(svg).toMatch(/<tspan[^>]*>一行目<\/tspan><tspan[^>]*>二行目<\/tspan>/)
  })

  test('escapes HTML tags written in a label instead of making elements', async () => {
    const svg = await svgOf('graph TD\n  A["<img src=x onerror=alert(1)>"]')
    expect(svg).not.toContain('<img')
    expect(svg).toContain('&lt;img')
  })

  test('does not fetch fonts from the network', async () => {
    const svg = await svgOf('graph TD\n  A --> B')
    expect(svg).not.toContain('@import')
  })

  test('returns the reason for an unsupported diagram type', async () => {
    expect(await renderMermaid('pie\n  "a": 1')).toEqual({
      error: expect.stringContaining('"pie"'),
    })
  })

  test('returns a reason instead of throwing for a half-written source', async () => {
    expect(await renderMermaid('grap')).toEqual({ error: expect.any(String) })
  })
})
