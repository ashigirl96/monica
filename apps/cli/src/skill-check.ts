import { readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import type { Command } from 'commander'

import { createProgram } from './program.ts'

export function inspectSkills(root: string): string[] {
  const program = cliProgram()
  const { skills } = JSON.parse(readFileSync(join(root, '.claude-plugin/plugin.json'), 'utf8'))
  const listedDirs = (skills as string[]).map((dir) => join(dir))
  const skillFiles = [
    ...new Bun.Glob('packages/*/skills/*/SKILL.md').scanSync({ cwd: root }),
  ].toSorted()
  const skillDirs = [...new Set(skillFiles.map(skillsDirOf))]
  const listedFiles = skillFiles.filter((path) => listedDirs.includes(skillsDirOf(path)))
  return [
    ...skillDirs
      .filter((dir) => !listedDirs.includes(dir))
      .map((dir) => `plugin.json does not list ${dir}`),
    ...listedDirs
      .filter((dir) => !skillDirs.includes(dir))
      .map((dir) => `plugin.json lists ${dir}, which has no Skill`),
    ...duplicateNames(listedFiles),
    ...listedFiles.flatMap((path) =>
      inspectSkill(path, readFileSync(join(root, path), 'utf8'), program),
    ),
  ]
}

const skillsDirOf = (path: string) => dirname(dirname(path))
const skillNameOf = (path: string) => basename(dirname(path))

// plugin の Skill は `/monica:<name>` で呼ぶので、package をまたぐ同名は片方が隠れる。
function duplicateNames(paths: string[]): string[] {
  return [...Map.groupBy(paths, skillNameOf)]
    .filter(([, same]) => same.length > 1)
    .map(
      ([name, same]) =>
        `more than one package has the Skill '${name}': ${same.map(dirname).join(', ')}`,
    )
}

function inspectSkill(path: string, markdown: string, program: Command): string[] {
  const problems: string[] = []
  const dir = skillNameOf(path)
  const name = nameOf(markdown)
  if (name !== dir) {
    problems.push(`${path}: name is ${describeName(name)}, not the directory name '${dir}'`)
  }
  for (const command of monicaCommands(markdown)) {
    const problem = checkCommand(program, command)
    if (problem) problems.push(`${path}: \`${command.text}\`: ${problem}`)
  }
  return problems
}

function nameOf(markdown: string): unknown {
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(markdown)?.[1]
  if (frontmatter === undefined) return undefined
  return (Bun.YAML.parse(frontmatter) as { name?: unknown } | null)?.name
}

function describeName(name: unknown): string {
  if (name === undefined) return 'missing'
  return typeof name === 'string' ? `'${name}'` : JSON.stringify(name)
}

// procedure は呼ばないので、Backend にも出力にも届かなくてよい。
function cliProgram(): Command {
  return createProgram([], { connect: () => null, stdout() {}, stderr() {} }).program
}

type MonicaCommand = { text: string; inShell: boolean }

const startsWithMonica = /^monica(\s|$)/

// 長い fence の中の短い fence は例として書いたものなので、外の fence を閉じない。
function monicaCommands(markdown: string): MonicaCommand[] {
  const found: MonicaCommand[] = []
  let fence: { marker: string; shell: boolean } | null = null
  for (const line of markdown.split('\n').map((raw) => raw.trimStart())) {
    if (fence) {
      if (line.startsWith(fence.marker) && /^(`+|~+)\s*$/.test(line)) fence = null
      else if (fence.shell && startsWithMonica.test(line)) found.push({ text: line, inShell: true })
      continue
    }
    const opened = /^(`{3,}|~{3,})\s*(\w*)/.exec(line)
    if (opened) {
      fence = { marker: opened[1]!, shell: /^(bash|sh)$/.test(opened[2]!) }
      continue
    }
    for (const [, code] of line.matchAll(/`([^`]+)`/g)) {
      if (startsWithMonica.test(code!)) found.push({ text: code!, inShell: false })
    }
  }
  return found
}

// commander は親の option も子の後ろで受けるので、辿った command の option をすべて数える。
function checkCommand(program: Command, { text, inShell }: MonicaCommand): string | null {
  let command = program
  const path = ['monica']
  const options = [...program.createHelp().visibleOptions(program)]
  const words = text.trim().split(/\s+/)
  const comment = words.findIndex((word) => word.startsWith('#'))
  const args = words.slice(1, comment === -1 ? undefined : comment)
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg.startsWith('-')) {
      const [flag] = arg.split('=')
      const option = options.find((o) => o.long === flag || o.short === flag)
      if (!option) {
        if (inShell) return `unknown option '${flag}'`
        continue
      }
      if (arg.includes('=')) continue
      if (option.required) {
        i++
        continue
      }
      // commander は `[value]` の option の後ろの語も、`-` で始まらなければ値として食う。
      const next = args[i + 1]
      if (option.optional && inShell && next !== undefined && !next.startsWith('-')) {
        return `option '${flag}' takes '${next}' as its value`
      }
      continue
    }
    if (command.commands.length === 0) continue
    const sub = command.commands.find((c) => c.name() === arg)
    if (!sub) return `unknown command '${arg}'`
    command = sub
    path.push(arg)
    options.push(...command.createHelp().visibleOptions(command))
  }
  if (inShell && command.commands.length > 0) {
    return `missing a command under '${path.join(' ')}'`
  }
  return null
}
