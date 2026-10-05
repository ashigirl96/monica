// sidebar は狭いので repo は owner を除いた名前にする。
export function taskLabel(ref: string, title: string): string {
  return `${ref.slice(ref.indexOf('/') + 1)} ${title}`
}
