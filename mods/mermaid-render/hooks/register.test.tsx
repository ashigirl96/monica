import { expect, test } from 'claude-code/testing'

const REPLY = {
  plugin: 'mermaid-render',
  component: 'AssistantMessage',
  requestId: 'msg-1',
  surface: 'terminal',
  viewport: { columns: 100, rows: 40 },
  props: {
    text: 'before\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\nafter',
    isFirstOfReply: true,
  },
} as const

test('a mermaid fence is drawn as the box-drawing text the helper returns, and left alone when off', async ($, on) => {
  let helper = ''
  on('process.run', (_, e) => {
    helper = (e as { argv: readonly string[] }).argv[1] ?? ''
    return {
      value: {
        exitCode: 0,
        stdout: JSON.stringify({ text: '┌───┐\n│ A │\n└───┘' }),
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('ui.render', (engine, e) => {
    const { Text } = engine.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('command.register', () => ({ value: { command: 'mermaid' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount(REPLY as never)
  await ui.find({ type: 'Text', text: /│ A │/ })
  expect((await ui.find({ type: 'Text', text: /│ A │/ }))?.text).toBe('│ A │')
  expect(helper).toMatch(/^\/.*\/render\/render\.ts$/)
  await ui.unmount()

  await $.command.run({ command: 'mermaid', args: 'off' } as never)
  const off = await $.ui.mount(REPLY as never)
  expect((await off.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await off.unmount()
})
