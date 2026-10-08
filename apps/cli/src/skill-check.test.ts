import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { inspectSkills } from './skill-check.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function plugin(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'monica-skills-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

const manifest = (...skills: string[]) => JSON.stringify({ name: 'monica', skills })

const skill = (name: string, body: string) => `---\nname: ${name}\ndescription: x\n---\n\n${body}`

test('the Skills the plugin ships call only commands and flags the CLI has', () => {
  expect(inspectSkills(join(import.meta.dir, '../../..'))).toEqual([])
})

test('a monica command the CLI does not have fails the check', () => {
  const root = plugin({
    '.claude-plugin/plugin.json': manifest('./packages/task/skills'),
    'packages/task/skills/look/SKILL.md': skill('look', '```bash\nmonica task nope\n```\n'),
  })

  expect(inspectSkills(root)).toEqual([
    "packages/task/skills/look/SKILL.md: `monica task nope`: unknown command 'nope'",
  ])
})

test('a flag the command does not take fails the check, while its own flags, --format and --help pass', () => {
  const root = plugin({
    '.claude-plugin/plugin.json': manifest('./packages/task/skills'),
    'packages/task/skills/look/SKILL.md': skill(
      'look',
      [
        '```bash',
        'monica task list --closed --format json',
        'monica --format=json task run acme/app#1 --in-place --force',
        'monica task attach --help',
        'monica task list --in-place',
        '```',
        '',
      ].join('\n'),
    ),
  })

  expect(inspectSkills(root)).toEqual([
    "packages/task/skills/look/SKILL.md: `monica task list --in-place`: unknown option '--in-place'",
  ])
})

test('a boolean flag before an argument fails the check, since commander takes the argument as its value', () => {
  const root = plugin({
    '.claude-plugin/plugin.json': manifest('./packages/task/skills'),
    'packages/task/skills/look/SKILL.md': skill(
      'look',
      [
        '```bash',
        'monica task close acme/app#1 --force',
        'monica task close --force acme/app#1',
        '```',
        '',
      ].join('\n'),
    ),
  })

  expect(inspectSkills(root)).toEqual([
    "packages/task/skills/look/SKILL.md: `monica task close --force acme/app#1`: option '--force' takes 'acme/app#1' as its value",
  ])
})

test('a line in a shell block names a command to run, not a group, and its comment is not checked', () => {
  const root = plugin({
    '.claude-plugin/plugin.json': manifest('./packages/task/skills'),
    'packages/task/skills/look/SKILL.md': skill(
      'look',
      '```sh\nmonica task list  # --all は無い\nmonica task\n```\n',
    ),
  })

  expect(inspectSkills(root)).toEqual([
    "packages/task/skills/look/SKILL.md: `monica task`: missing a command under 'monica task'",
  ])
})

test('a shell block indented under a list item is checked, and one inside a longer fence is an example that is not', () => {
  const root = plugin({
    '.claude-plugin/plugin.json': manifest('./packages/task/skills'),
    'packages/task/skills/look/SKILL.md': skill(
      'look',
      [
        '1. 一覧を見る。',
        '',
        '   ```bash',
        '   monica task lsit',
        '   ```',
        '',
        '````markdown',
        '```bash',
        'monica task nope',
        '```',
        '````',
        '',
      ].join('\n'),
    ),
  })

  expect(inspectSkills(root)).toEqual([
    "packages/task/skills/look/SKILL.md: `monica task lsit`: unknown command 'lsit'",
  ])
})

test('a Skill whose name is not its directory name fails the check, since Claude Code calls it by the name', () => {
  const root = plugin({
    '.claude-plugin/plugin.json': manifest('./packages/task/skills'),
    'packages/task/skills/look/SKILL.md': skill('peek', '見る。\n'),
    'packages/task/skills/bare/SKILL.md': '見る。\n',
  })

  expect(inspectSkills(root).toSorted()).toEqual([
    "packages/task/skills/bare/SKILL.md: name is missing, not the directory name 'bare'",
    "packages/task/skills/look/SKILL.md: name is 'peek', not the directory name 'look'",
  ])
})

test('a Skill name in more than one package fails the check, since the later one would shadow the other', () => {
  const root = plugin({
    '.claude-plugin/plugin.json': manifest('./packages/task/skills', './packages/workbench/skills'),
    'packages/task/skills/look/SKILL.md': skill('look', '見る。\n'),
    'packages/workbench/skills/look/SKILL.md': skill('look', '見る。\n'),
  })

  expect(inspectSkills(root)).toEqual([
    "more than one package has the Skill 'look': packages/task/skills/look, packages/workbench/skills/look",
  ])
})

test('plugin.json fails the check unless it lists exactly the packages/*/skills that have a Skill', () => {
  const root = plugin({
    '.claude-plugin/plugin.json': manifest('./packages/task/skills', './packages/ui/skills'),
    'packages/task/skills/look/SKILL.md': skill('look', '見る。\n'),
    'packages/workbench/skills/peek/SKILL.md': skill('peek', '見る。\n'),
  })

  expect(inspectSkills(root)).toEqual([
    'plugin.json does not list packages/workbench/skills',
    'plugin.json lists packages/ui/skills, which has no Skill',
  ])
})

test('an inline monica in prose is checked for its command path only', () => {
  const root = plugin({
    '.claude-plugin/plugin.json': manifest('./packages/task/skills'),
    'packages/task/skills/look/SKILL.md': skill(
      'look',
      '`monica` の `monica task` から `monica task list --nope` を打ち、`monica task lsit` は打たない。\n',
    ),
  })

  expect(inspectSkills(root)).toEqual([
    "packages/task/skills/look/SKILL.md: `monica task lsit`: unknown command 'lsit'",
  ])
})
