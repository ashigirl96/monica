// 通知の title と Attach の picker の行に並べるので、repo は owner を除いた短い名前にする。
export function taskLabel(ref: string, title: string): string {
  return `${ref.slice(ref.indexOf('/') + 1)} ${title}`
}
