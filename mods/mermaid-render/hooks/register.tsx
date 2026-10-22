import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Mode, Rendered } from '../types'

const mode = atom({ plugin: 'mermaid-render', key: 'mode' } as const, 'ascii' as Mode)
const rendered = atom(
  { plugin: 'mermaid-render', key: 'rendered' } as const,
  {} as Record<string, Rendered>,
)

const FENCE = /```mermaid[^\n]*\n([\s\S]*?)```/g

type Part = { kind: 'markdown'; text: string } | { kind: 'diagram'; source: string }

function split(text: string): Part[] {
  const parts: Part[] = []
  let last = 0
  for (const m of text.matchAll(FENCE)) {
    if (m.index > last) parts.push({ kind: 'markdown', text: text.slice(last, m.index) })
    parts.push({ kind: 'diagram', source: m[1] ?? '' })
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push({ kind: 'markdown', text: text.slice(last) })
  return parts
}

// 補助 script の描き方を変えたら上げる。$.state に残った古い描画を使わないため。
const RENDER_VERSION = 3
const cacheKey = (source: string) => `${RENDER_VERSION}:${source}`

const inFlight = new Set<string>()
// 失敗は $.state に残さず、mod の reload で忘れて描き直せるようにする。
const failures = new Map<string, string>()

async function startRender($: EngineInterface, source: string) {
  if (inFlight.has(source)) return
  inFlight.add(source)
  const ran = await $.process.run(['bun', `${$.plugin.root}/render/render.ts`], {
    stdin: JSON.stringify({ source }),
    timeoutMs: 20000,
  })
  if (ran.exitCode === 0) {
    const result: Rendered = {
      kind: 'ascii',
      text: (JSON.parse(ran.stdout) as { text: string }).text,
    }
    await update($, rendered, (all) => ({ ...all, [cacheKey(source)]: result }))
  } else {
    failures.set(source, ran.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300))
    $.ui.invalidate('ui.render')
  }
  inFlight.delete(source)
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'mermaid',
      description: 'Draw ```mermaid blocks as box-drawing text (ascii) or leave them (off)',
      argumentHint: 'ascii|off',
    })
    return next(e)
  })

  on('command.run', { command: 'mermaid' }, async ($, e) => {
    const asked = e.args.trim()
    if (asked === 'ascii' || asked === 'off') {
      await update($, mode, () => asked)
      $.ui.invalidate('ui.render')
      return { text: `mermaid: ${asked}` }
    }
    return { text: `mermaid: ${await read($, mode)} (use /mermaid ascii|off)` }
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (
      e.surface !== 'terminal' ||
      (await read($, mode)) !== 'ascii' ||
      !e.props.text.includes('```mermaid')
    )
      return next(e)
    const parts = split(e.props.text)
    if (!parts.some((p) => p.kind === 'diagram')) return next(e)

    const { Box, Code, Markdown, Text } = $.ui.resolve(e)
    const all = await read($, rendered)

    return (
      <Box flexDirection="column">
        {parts.map((part, i) => {
          if (part.kind === 'markdown')
            return part.text.trim() === '' ? null : <Markdown key={`m${i}`} text={part.text} />
          const done = all[cacheKey(part.source)]
          const failure = failures.get(part.source)
          if (failure !== undefined) {
            return (
              <Box key={`d${i}`} flexDirection="column">
                <Code language="mermaid" source={part.source} />
                <Text dimColor>mermaid-render: {failure}</Text>
              </Box>
            )
          }
          if (done?.kind !== 'ascii') {
            void startRender($, part.source)
            return <Code key={`d${i}`} language="mermaid" source={part.source} />
          }
          // 折り返すと罫線が崩れるので、端末より広い図は行末で切る。
          return (
            <Box key={`d${i}`} flexDirection="column">
              {done.text.split('\n').map((line, j) => (
                <Text key={`l${j}`} wrap="truncate-end">
                  {line}
                </Text>
              ))}
            </Box>
          )
        })}
      </Box>
    )
  })
}
