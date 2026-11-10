import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, normalize, sep } from 'node:path'

import { ORPCError } from '@orpc/server'

const MAX_READ_BYTES = 1024 * 1024
const TOP_ARTIFACTS = ['MISSION.md', 'RESOURCES.md', 'GLOSSARY.md', 'log.md']
const LEARNING_RECORDS = 'learning-records'

export type Artifact = { path: string; title: string | null }

const forbidden = (path: string) =>
  new ORPCError('FORBIDDEN', { message: `${path} is not a file in the Study dir` })

/** Tutor が置いた symlink や FIFO を通さないよう、realpath で Study の dir の中の通常の file かを確かめる。 */
export function resolveArtifact(dir: string, path: string): string {
  // 外の file が在るかを NOT_FOUND と FORBIDDEN の違いで漏らさないよう、realpath より先に断る。
  if (isAbsolute(path) || normalize(path).split(sep)[0] === '..') throw forbidden(path)
  let real: string
  try {
    real = realpathSync(join(dir, path))
  } catch {
    throw new ORPCError('NOT_FOUND', { message: `no ${path} in the Study dir` })
  }
  if (!real.startsWith(realpathSync(dir) + sep)) throw forbidden(path)
  if (!statSync(real).isFile()) throw forbidden(path)
  return real
}

export function readArtifact(dir: string, path: string): string {
  const real = resolveArtifact(dir, path)
  if (statSync(real).size > MAX_READ_BYTES) {
    throw new ORPCError('FORBIDDEN', { message: `${path} is over 1 MiB` })
  }
  return readFileSync(real, 'utf8')
}

function titleOf(dir: string, path: string, name: string): string {
  let heading: string | undefined
  try {
    heading = readArtifact(dir, path)
      .split('\n')
      .find((line) => line.startsWith('# '))
  } catch {
    heading = undefined
  }
  return heading?.slice(2).trim() || name.replace(/^\d+-?/, '').replace(/\.md$/, '')
}

export function listArtifacts(dir: string): Artifact[] {
  const top = TOP_ARTIFACTS.filter((name) => existsSync(join(dir, name))).map((path) => ({
    path,
    title: null,
  }))
  let names: string[] = []
  try {
    names = readdirSync(join(dir, LEARNING_RECORDS), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name)
      .toSorted()
  } catch {
    names = []
  }
  const records = names.map((name) => {
    const path = `${LEARNING_RECORDS}/${name}`
    return { path, title: titleOf(dir, path, name) }
  })
  return [...top, ...records]
}
