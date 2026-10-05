import { expect, mock, test } from 'bun:test'

// Shell は command を別々の thread で走らせるので、先に呼ばれた command が後から届くことがある。
const delivered: string[] = []
const tauriCore = await import('@tauri-apps/api/core')
await mock.module('@tauri-apps/api/core', () => ({
  ...tauriCore,
  invoke: async (command: string, args: { data?: string; rows?: number }) => {
    const label = command === 'terminal_write' ? args.data! : `${command}:${args.rows}`
    await Bun.sleep(label.includes('slow') || args.rows === 10 ? 20 : 0)
    delivered.push(label)
  },
}))

const { terminalResize, terminalWrite } = await import('./terminal.ts')

test('writes to a Terminal Session reach it in the order they were made', async () => {
  delivered.length = 0

  await Promise.all([terminalWrite('ts-1', 'slow'), terminalWrite('ts-1', 'fast')])

  expect(delivered).toEqual(['slow', 'fast'])
})

test('resizes of a Terminal Session reach it in the order they were made', async () => {
  delivered.length = 0

  await Promise.all([terminalResize('ts-1', 10, 80), terminalResize('ts-1', 30, 80)])

  expect(delivered).toEqual(['terminal_resize:10', 'terminal_resize:30'])
})
