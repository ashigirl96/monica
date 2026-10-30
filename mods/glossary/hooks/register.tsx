import { atom, read, update } from 'claude-code'
import type { CommandRunInput, EngineInterface, ModelForkResult, Register } from 'claude-code'

import type { Term } from '../types'
import { cells, fit, wrap } from './wrap'

const PANE = 'glossary'
const TITLE = '用語辞典'
const TOOL = 'mcp__glossary__show_terms'
const terms = atom({ plugin: 'glossary', key: 'terms' } as const, [], {
  shape: 'terms-1',
})
const pending = atom({ plugin: 'glossary', key: 'pending' } as const, [], {
  shape: 'pending-1',
})
const open = atom({ plugin: 'glossary', key: 'open' } as const, null, {
  shape: 'open-1',
})
const ACCENT = 'suggestion'

const field = { type: 'string' }

const show = async ($: EngineInterface, asked: Term[]) => {
  const askedNames = new Set(asked.map((t) => t.term))
  await update($, terms, (list) =>
    [...asked, ...list.filter((t) => !askedNames.has(t.term))].slice(0, 50),
  )
  await update($, open, () => asked[0]?.term ?? null)

  return $.ui.open({ id: PANE, title: TITLE })
}

const askPrompt = (term: string, glossary: string, withSession: boolean) => {
  const source = withSession ? 'このセッションの会話と、下の GLOSSARY.md' : '下の GLOSSARY.md'
  const scope = withSession ? 'この codebase とこのセッション' : 'この codebase'

  return (
    `「${term}」を用語辞典に載せる。${source}（空なら無い）を踏まえ、次の形の JSON オブジェクトだけを返す。前置きとコードフェンスは付けない。\n` +
    `{"term": 見出し語, "ja": 日本語の語と読み, "en": 英語の語, "nuance": 語そのものの含みと近い語との違い, "codebase": ${scope}での意味。根拠の file 名を添え、分からなければそう書く}\n` +
    'en 以外は日本語で書く。\n' +
    `<glossary>\n${glossary}\n</glossary>`
  )
}

const parseTerm = (text: string): Term | undefined => {
  const json = text.match(/\{[\s\S]*\}/)?.[0]
  if (json === undefined) return undefined
  try {
    const t = JSON.parse(json)
    const isTerm = ['term', 'ja', 'en', 'nuance', 'codebase'].every((k) => typeof t[k] === 'string')

    return isTerm ? t : undefined
  } catch {
    return undefined
  }
}

const lookUp = async ($: EngineInterface, term: string, withSession: boolean) => {
  await update($, pending, (list) => [...list, term])
  try {
    const glossary = await $.fs.read('GLOSSARY.md').catch(() => '')
    const prompt = askPrompt(term, glossary, withSession)
    let reply: ModelForkResult = withSession
      ? await $.model.fork({ prompt })
      : await $.model.complete({ model: 'haiku', prompt })
    // fork reads this session's conversation; before the first turn there is none to read.
    if (!reply.isAnswered && reply.reason === 'nothing-to-fork') {
      reply = await $.model.complete({ model: 'sonnet', prompt })
    }
    const found = reply.isAnswered ? parseTerm(reply.text) : undefined
    if (found) await show($, [found])
    else $.ui.toast(`用語辞典: 「${term}」を調べられませんでした`)
  } finally {
    await update($, pending, (list) => list.filter((t) => t !== term))
  }
}

const ask = async ($: EngineInterface, e: CommandRunInput, withSession: boolean) => {
  const term = e.args.trim().slice(0, 80)
  if (term === '') {
    const isShown = (await $.ui.panes()).some((p) => p.id === PANE && p.isPlaced && p.isShown)
    if (isShown) {
      await $.ui.close({ id: PANE })
      return {}
    }
    await $.ui.open({ id: PANE, title: TITLE })
    return {}
  }
  await $.ui.open({ id: PANE, title: TITLE })
  // The lookup runs on a timer so the prompt is free while the model answers.
  $.clock.after(0, () => void lookUp($, term, withSession))

  return {}
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'glossary',
      description:
        '用語を GLOSSARY.md から軽く調べ、用語辞典の pane に出す（引数なしなら開くだけ）',
    })
    await $.command.register({
      name: 'glossary-session',
      description:
        '用語をこの session の会話も踏まえて調べ、用語辞典の pane に出す（会話全体を送るので重い）',
    })
    await $.tool.register({
      name: 'show_terms',
      description:
        'Show terms in the glossary side pane. Call this whenever the user asks what a term, jargon or identifier means (e.g. 「〇〇って何?」, "what is X"). ' +
        'For each term give: ja (Japanese word and reading), en (English word), nuance (the connotation of the word itself, how it differs from near-synonyms), ' +
        'codebase (what it means in the current codebase: check GLOSSARY.md, docs/adr and the code first, and cite the file). Write all fields in Japanese except en. ' +
        'After calling, reply in chat with only a one-line summary; the pane holds the detail.',
      inputSchema: {
        type: 'object',
        properties: {
          terms: {
            type: 'array',
            items: {
              type: 'object',
              properties: { term: field, ja: field, en: field, nuance: field, codebase: field },
              required: ['term', 'ja', 'en', 'nuance', 'codebase'],
            },
          },
        },
        required: ['terms'],
      },
      isDeferred: false,
    })

    return next(e)
  })

  on('command.run', { command: 'glossary' }, ($, e) => ask($, e, false))
  on('command.run', { command: 'glossary-session' }, ($, e) => ask($, e, true))

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const asked = (e as unknown as { terms: Term[] }).terms
    const opened = await show($, asked)
    const where = opened.isPlaced
      ? 'Shown in the glossary pane.'
      : 'Saved; the pane is not drawn (terminal too narrow), so also give the details in chat.'

    return { result: `${where} ${asked.map((t) => t.term).join(', ')}` }
  }).catch(() => ({ deny: 'The glossary pane failed; give the details in chat.' }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, terms)
    const waiting = await read($, pending)
    const chosen = await read($, open)
    const current = list.find((t) => t.term === chosen) ?? list[0]
    const rest = list.filter((t) => t !== current)
    const width = Math.max(10, e.props.bodyColumns - 2)

    const ruled = (key: string, line: string, style: { dimColor?: boolean } = {}) => (
      <Text key={key}>
        <Text color={ACCENT}>┃ </Text>
        <Text {...style}>{line}</Text>
      </Text>
    )
    const ruledLines = (body: string) => wrap(body, width).map((line, i) => ruled(`l${i}`, line))
    const section = (label: string, body: string) => (
      <Box flexDirection="column">
        <Text color={ACCENT}>┃</Text>
        {ruled('label', label, { dimColor: true })}
        {ruledLines(body)}
      </Box>
    )

    return (
      <Box flexDirection="column">
        {waiting.map((t) => (
          <Text key={`w:${t}`} dimColor>
            「{fit(t, width - 10)}」を調べています
          </Text>
        ))}
        {list.length === 0 && waiting.length === 0 && (
          <Box flexDirection="column">
            <Text>用語を調べると、ここに出ます。</Text>
            <Text> </Text>
            <Text>/glossary 用語</Text>
            <Text dimColor>{'  GLOSSARY.md から軽く調べる'}</Text>
            <Text>/glossary-session 用語</Text>
            <Text dimColor>{'  この会話も踏まえて調べる'}</Text>
          </Box>
        )}
        {current && (
          <Box flexDirection="column" marginTop={waiting.length > 0 ? 1 : 0}>
            <Text>
              <Text color={ACCENT}>┃ </Text>
              <Text color={ACCENT} weight="bold">
                {fit(current.term, width)}
              </Text>
              {current.en.toLowerCase() !== current.term.toLowerCase() && (
                <Text dimColor>
                  {'  '}
                  {fit(current.en, Math.max(0, width - cells(current.term) - 2))}
                </Text>
              )}
            </Text>
            {ruledLines(current.ja)}
            {section('ニュアンス', current.nuance)}
            {section('この codebase では', current.codebase)}
          </Box>
        )}
        {rest.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            {rest.map((t, i) => (
              <Button
                key={`term:${t.term}`}
                plain
                {...(i < 9 ? { hotkey: String(i + 1) } : {})}
                onPress={() => update($, open, () => t.term)}
              >
                {fit(t.term, width - 3)}
                <Text dimColor>
                  {'  '}
                  {fit(t.ja, Math.max(0, width - 5 - cells(t.term)))}
                </Text>
              </Button>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
