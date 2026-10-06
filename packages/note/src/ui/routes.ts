// 保存済みの本文の link がこの形を持つ。
export function notePath(id: string): string {
  return `/notes/${id}`
}

export function noteIdOfPath(pathname: string): string | null {
  const match = /^\/notes\/([^/]+)\/?$/.exec(pathname)
  if (!match) return null
  try {
    return decodeURIComponent(match[1]!)
  } catch {
    return null
  }
}
