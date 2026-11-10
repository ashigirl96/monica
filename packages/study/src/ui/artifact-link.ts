import type { StudyMessage } from '../contract.ts'

/** Tutor が Study の dir の中に Write か Edit した tool の行なら、その file の Study の dir からの path。 */
export function writtenArtifact(
  message: Pick<StudyMessage, 'kind' | 'tool' | 'text'>,
  dir: string,
): string | null {
  if (message.kind !== 'tool' || (message.tool !== 'Write' && message.tool !== 'Edit')) return null
  return message.text.startsWith(`${dir}/`) ? message.text.slice(dir.length + 1) : null
}

/** 開いている成果物 `from` の中の scheme の無い link を、Study の dir からの path に解く。外に出るなら null。 */
export function artifactLinkTarget(from: string, href: string): string | null {
  const target = href.replace(/[?#].*$/, '')
  if (target === '' || target.startsWith('/')) return null
  const parts = from.split('/').slice(0, -1)
  for (const part of target.split('/')) {
    if (part === '..') {
      if (parts.length === 0) return null
      parts.pop()
    } else if (part !== '.' && part !== '') {
      parts.push(part)
    }
  }
  return parts.length === 0 ? null : parts.join('/')
}
