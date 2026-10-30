import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'glossary',
  component: 'Pane',
  requestId: 'glossary',
  props: {
    title: '用語辞典',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const term = (name: string, codebase: string) => ({
  term: name,
  ja: 'ベンチ',
  en: 'bench',
  nuance: '作業台',
  codebase,
})

test('a term the model shows lands in the pane, the newest answer replacing the old', async ($, on) => {
  on('command.register', () => ({ value: { command: 'glossary' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__glossary__show_terms' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__glossary__show_terms', terms: [term('Bench', '古い説明')] })
  await $.tool.call({
    tool: 'mcp__glossary__show_terms',
    terms: [term('Bench', 'Task の作業場所')],
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Task の作業場所/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /古い説明/ })).toBeUndefined()
  await ui.unmount()
})

test('only the newest term is open; pressing a folded one opens it instead', async ($, on) => {
  on('command.register', () => ({ value: { command: 'glossary' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__glossary__show_terms' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: 'mcp__glossary__show_terms',
    terms: [term('Bench', 'Task の作業場所')],
  })
  await $.tool.call({
    tool: 'mcp__glossary__show_terms',
    terms: [term('Run', 'Agent Session 1 回分')],
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Agent Session 1 回分/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Task の作業場所/ })).toBeUndefined()

  await ui.press({ key: 'term:Bench' })
  expect(await ui.find({ type: 'Text', text: /Task の作業場所/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Agent Session 1 回分/ })).toBeUndefined()
  await ui.unmount()
})

const RUN = '**Run**: Agent Session 1 回分'
const cases = [
  {
    when: 'GLOSSARY.md names the term',
    command: 'glossary',
    glossary: RUN,
    asks: 'model.complete',
    model: 'haiku',
  },
  {
    when: 'there is no GLOSSARY.md',
    command: 'glossary',
    glossary: undefined,
    asks: 'model.fork',
    model: undefined,
  },
  {
    when: 'GLOSSARY.md never names the term',
    command: 'glossary',
    glossary: '**Bench**: Task の作業場所',
    asks: 'model.fork',
    model: undefined,
  },
  {
    when: 'GLOSSARY.md names the term',
    command: 'glossary-session',
    glossary: RUN,
    asks: 'model.fork',
    model: undefined,
  },
] as const

for (const c of cases) {
  test(`/${c.command} asks ${c.asks} when ${c.when}, and shows its answer in the pane`, async ($, on) => {
    const clock = mock.clock(on)
    on('command.register', (_, e) => ({ value: { command: e.name } }))
    on('tool.register', () => ({ value: { tool: 'mcp__glossary__show_terms' } }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('fs.read', () =>
      c.glossary === undefined ? { deny: 'no such file' } : { value: c.glossary },
    )
    const asked: { event: string; prompt: string; model?: string }[] = []
    const answer = (event: string) => (_: unknown, e: { prompt: string; model?: string }) => {
      asked.push({ event, prompt: e.prompt, model: e.model })
      return {
        value: {
          isAnswered: true as const,
          text: `答え: ${JSON.stringify(term('Run', 'Agent Session 1 回分'))}`,
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      }
    }
    on('model.fork', answer('model.fork'))
    on('model.complete', answer('model.complete'))

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    const ran = await $.command.run({ command: c.command, args: 'Run' } as Parameters<
      typeof $.command.run
    >[0])
    expect(ran.text).toBeUndefined()
    await clock.advance(1)

    expect(asked.map((a) => [a.event, a.model])).toEqual([[c.asks, c.model]])
    expect(asked[0]?.prompt).toContain(c.glossary ?? '<glossary>\n\n</glossary>')
    expect(asked[0]?.prompt.includes('このセッションの会話')).toBe(c.asks === 'model.fork')
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /Agent Session 1 回分/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /調べています/ })).toBeUndefined()
    await ui.unmount()
  })
}

test('/glossary with no term leaves no transcript line, closes the pane when it is in front, and opens it otherwise', async ($, on) => {
  let panes: {
    id: string
    title: string
    isShown: boolean
    isFocused: boolean
    isPlaced: boolean
  }[] = []
  const calls: string[] = []
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', () => ({ value: { tool: 'mcp__glossary__show_terms' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.panes', () => ({ value: panes }))
  on('ui.open', () => {
    calls.push('open')
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => {
    calls.push('close')
    return { value: undefined }
  })
  const run = () =>
    $.command.run({ command: 'glossary', args: '' } as Parameters<typeof $.command.run>[0])

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await run()

  panes = [{ id: 'glossary', title: '用語辞典', isShown: true, isFocused: false, isPlaced: true }]
  await run()

  panes = [{ id: 'glossary', title: '用語辞典', isShown: false, isFocused: false, isPlaced: true }]
  await run()
  expect(calls).toEqual(['open', 'close', 'open'])
  expect((await run()).text).toBeUndefined()
})
