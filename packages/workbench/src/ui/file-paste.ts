import { shell } from './shell.ts'

const ESCAPED_CHARS = /[\\ ()[\]{}<>"'`!#$&;|*?\t]/g

export function joinEscapedPaths(paths: readonly string[]): string {
  return paths.map((path) => path.replace(ESCAPED_CHARS, '\\$&')).join(' ')
}

function clipboardReadFilePaths(): Promise<string[]> {
  return shell('clipboard_read_file_paths', {})
}

// WebKit は clipboard にファイルがあると page に text を見せないので、text が空のときだけ Shell に path を訊く。
export async function pasteFilePaths(event: ClipboardEvent, paste: (text: string) => void) {
  const data = event.clipboardData
  if (!data || data.getData('text/plain')) return
  event.preventDefault()
  event.stopPropagation()
  let paths: string[] = []
  try {
    paths = await clipboardReadFilePaths()
  } catch (e) {
    console.warn('reading file paths from the clipboard failed:', e)
  }
  paste(joinEscapedPaths(paths))
}
