import type { Command, Option } from 'commander'
import { kebabCase } from 'trpc-cli'

import type { Client } from './backend.ts'

type Candidate = { value: string; description?: string }

type Completer = (client: Client, signal: AbortSignal) => Promise<Candidate[]>

const COMPLETER_TIMEOUT_MS = 1000

export async function complete(
  program: Command,
  words: string[],
  { completers, connect }: { completers: unknown; connect: () => Client | null },
): Promise<Candidate[]> {
  let command = program
  const path: string[] = []
  let positionals = 0
  let awaitingValue: Option | null = null
  const current = words.at(-1) ?? ''
  for (const word of words.slice(0, -1)) {
    if (awaitingValue && consumes(awaitingValue, word)) {
      awaitingValue = null
      continue
    }
    awaitingValue = null
    if (word.startsWith('-')) {
      const option = findOption(command, word)
      if (option && (option.required || option.optional) && !word.includes('=')) {
        awaitingValue = option
      }
      continue
    }
    if (command.commands.length === 0) {
      positionals++
      continue
    }
    const sub = command.commands.find((c) => c.name() === word)
    if (!sub) return []
    command = sub
    path.push(word)
  }
  if (awaitingValue && consumes(awaitingValue, current)) return choices(awaitingValue.argChoices)
  if (current.startsWith('-')) {
    const [flag] = current.split('=')
    if (current.includes('=')) {
      return choices(findOption(command, current)?.argChoices).map(({ value }) => ({
        value: `${flag}=${value}`,
      }))
    }
    return options(command).map(([long, o]) => ({ value: long, description: o.description }))
  }
  if (command.commands.length > 0) {
    return command
      .createHelp()
      .visibleCommands(command)
      .map((c) => ({ value: c.name(), description: c.description() }))
  }
  const argument = command.registeredArguments[positionals]
  if (!argument) return []
  const completer = lookupByCommandName(completers, [...path, argument.name()]) as
    | Completer
    | undefined
  if (!completer) return choices(argument.argChoices)
  const client = connect()
  if (!client) return []
  try {
    return await completer(client, AbortSignal.timeout(COMPLETER_TIMEOUT_MS))
  } catch {
    return []
  }
}

// commander は `[value]` の option の後ろの語も、`-` で始まらなければ値として食う。
function consumes(option: Option, word: string): boolean {
  return !(option.optional && word.startsWith('-'))
}

function findOption(command: Command, word: string): Option | undefined {
  const [flag] = word.split('=')
  return options(command).find(([long, o]) => long === flag || o.short === flag)?.[1]
}

// commander は親の option も子の後ろで受けるので、親まで遡って集める。
function options(command: Command): [long: string, option: Option][] {
  const found = new Map<string, Option>()
  for (let c: Command | null = command; c; c = c.parent) {
    for (const option of c.createHelp().visibleOptions(c)) {
      if (option.long && !found.has(option.long)) found.set(option.long, option)
    }
  }
  return [...found]
}

function choices(values: readonly string[] | undefined): Candidate[] {
  return (values ?? []).map((value) => ({ value }))
}

// command の名前は trpc-cli が contract の key を kebab-case にしたもの。
function lookupByCommandName(root: unknown, names: string[]): unknown {
  return names.reduce<unknown>(
    (node, name) =>
      node && typeof node === 'object'
        ? Object.entries(node).find(([key]) => kebabCase(key) === name)?.[1]
        : undefined,
    root,
  )
}

// fpath から autoload されたときは関数の本体として走り、eval や source されたときは compdef で登録する。
export const zshScript = `#compdef monica

_monica() {
  local -a candidates
  candidates=(\${(f)"$("\${words[1]}" __complete -- "\${(@)words[2,CURRENT]}" 2>/dev/null)"})
  _describe -V monica candidates
}

if [[ "\${funcstack[1]}" == _monica ]]; then
  _monica "$@"
else
  compdef _monica monica
fi
`

// zsh の `_describe` が読む `value:description` の行。
export function describeLines(candidates: Candidate[]): string {
  return candidates
    .map(({ value, description }) => (description ? `${value}:${description}\n` : `${value}\n`))
    .join('')
}
