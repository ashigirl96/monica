import { beforeEach, expect, mock, test } from 'bun:test'

// Shell の command は Tauri の外では呼べないので、呼ばれた command を記録し、台本どおりに返すか断る。
const shellCalls: string[] = []
let clipboardFilePaths: string[] = []
let pasteboardUnavailable = false
const tauriCore = await import('@tauri-apps/api/core')
await mock.module('@tauri-apps/api/core', () => ({
  ...tauriCore,
  invoke: async (command: string) => {
    shellCalls.push(command)
    if (pasteboardUnavailable) throw 'the pasteboard is unavailable'
    return clipboardFilePaths
  },
}))

const { joinEscapedPaths, pasteFilePaths } = await import('./file-paste.ts')

function pasteEvent(text: string) {
  let stopped = false
  const event = {
    clipboardData: { getData: (format: string) => (format === 'text/plain' ? text : '') },
    preventDefault: () => {
      stopped = true
    },
    stopPropagation: () => {
      stopped = true
    },
  }
  return { event: event as unknown as ClipboardEvent, stopped: () => stopped }
}

const pasted: string[] = []
const paste = (text: string) => {
  pasted.push(text)
}

beforeEach(() => {
  shellCalls.length = 0
  clipboardFilePaths = []
  pasteboardUnavailable = false
  pasted.length = 0
})

test('leaves a text paste to xterm without asking the Shell', async () => {
  const { event, stopped } = pasteEvent('echo hi')

  await pasteFilePaths(event, paste)

  expect(shellCalls).toEqual([])
  expect(stopped()).toBe(false)
  expect(pasted).toEqual([])
})

test('pastes the copied files as escaped paths separated by a space', async () => {
  clipboardFilePaths = ['/Users/me/Downloads/shot.png', '/Users/me/My Files/a (1).png']
  const { event, stopped } = pasteEvent('')

  await pasteFilePaths(event, paste)

  expect(shellCalls).toEqual(['clipboard_read_file_paths'])
  expect(stopped()).toBe(true)
  expect(pasted).toEqual(['/Users/me/Downloads/shot.png /Users/me/My\\ Files/a\\ \\(1\\).png'])
})

// 空の bracketed paste を受けた claude は clipboard の画像を読むので、スクリーンショットはこの経路で貼れる。
test('sends an empty paste when the clipboard holds no files', async () => {
  const { event } = pasteEvent('')

  await pasteFilePaths(event, paste)

  expect(pasted).toEqual([''])
})

test('falls back to an empty paste when the Shell cannot read the clipboard', async () => {
  pasteboardUnavailable = true
  const { event } = pasteEvent('')

  await pasteFilePaths(event, paste)

  expect(pasted).toEqual([''])
})

// 期待値は Ghostty の macos/Tests/Ghostty/ShellTests.swift の escape の表。
test.each([
  ['hello', 'hello'],
  ['file name', 'file\\ name'],
  ['a\\b', 'a\\\\b'],
  ['(foo)', '\\(foo\\)'],
  ['[bar]', '\\[bar\\]'],
  ['{baz}', '\\{baz\\}'],
  ['<qux>', '\\<qux\\>'],
  ['say"hi"', 'say\\"hi\\"'],
  ["it's", "it\\'s"],
  ['`cmd`', '\\`cmd\\`'],
  ['wow!', 'wow\\!'],
  ['#comment', '\\#comment'],
  ['$HOME', '\\$HOME'],
  ['a&b', 'a\\&b'],
  ['a;b', 'a\\;b'],
  ['a|b', 'a\\|b'],
  ['*.txt', '\\*.txt'],
  ['file?.log', 'file\\?.log'],
  ['col1\tcol2', 'col1\\\tcol2'],
  ["$(echo 'hi')", "\\$\\(echo\\ \\'hi\\'\\)"],
  ['/tmp/my file (1).txt', '/tmp/my\\ file\\ \\(1\\).txt'],
])('escapes %p the way Ghostty does', (path, escaped) => {
  expect(joinEscapedPaths([path])).toBe(escaped)
})
