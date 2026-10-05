import { beforeEach, expect, mock, test } from 'bun:test'

// Shell の command は Tauri の外では呼べないので、呼ばれた command を記録し、失敗させたい path だけを断る。
const shellCalls: { command: string; args: Record<string, unknown> }[] = []
const unreadable = new Set<string>()
const tauriCore = await import('@tauri-apps/api/core')
await mock.module('@tauri-apps/api/core', () => ({
  ...tauriCore,
  invoke: async (command: string, args: Record<string, unknown>) => {
    shellCalls.push({ command, args })
    if (unreadable.has(args.path as string)) throw `cannot read an image from ${args.path}`
  },
}))

// toast は画面の外にあるので、出した文言だけを記録する。
const toasts: string[] = []
const ui = await import('@tania/ui')
await mock.module('@tania/ui', () => ({
  ...ui,
  pushErrorToast: (message: string) => {
    toasts.push(message)
  },
}))

const { pasteDroppedImage } = await import('./image-drop.ts')

let pastes = 0
const paste = () => {
  pastes++
}

beforeEach(() => {
  shellCalls.length = 0
  unreadable.clear()
  toasts.length = 0
  pastes = 0
})

test('puts the first dropped image on the clipboard and pastes it', async () => {
  await pasteDroppedImage(['/tmp/notes.txt', '/tmp/shot.png', '/tmp/other.jpg'], paste)

  expect(shellCalls).toEqual([
    { command: 'clipboard_write_image', args: { path: '/tmp/shot.png' } },
  ])
  expect(pastes).toBe(1)
})

test('recognises an image by its extension regardless of case', async () => {
  await pasteDroppedImage(['/tmp/IMG_0001.JPG'], paste)

  expect(shellCalls).toEqual([
    { command: 'clipboard_write_image', args: { path: '/tmp/IMG_0001.JPG' } },
  ])
})

test('leaves the clipboard alone when nothing dropped is an image', async () => {
  await pasteDroppedImage(['/tmp/notes.txt', '/tmp/png'], paste)

  expect(shellCalls).toEqual([])
  expect(pastes).toBe(0)
})

// 貼ってしまうと、clipboard に元からあった文字が agent に入る。
test('tells the user and pastes nothing when the image cannot be read', async () => {
  unreadable.add('/tmp/broken.png')

  await pasteDroppedImage(['/tmp/broken.png'], paste)

  expect(toasts).toEqual(['Image drop failed: cannot read an image from /tmp/broken.png'])
  expect(pastes).toBe(0)
})
