import { expect, test } from 'bun:test'

import type { CurrentOutput, ListItem } from '../contract.ts'
import { attachChoices } from './attach-choices.ts'

const item = (ref: string, displayState: ListItem['displayState']): ListItem => ({
  ref,
  title: 'Ship it',
  issueState: 'open',
  blockers: [],
  cwd: null,
  displayState,
})

const tracked = [
  item('acme/app#1', { state: 'not_started' }),
  item('acme/app#2', { state: 'ended' }),
  item('acme/app#3', { state: 'ended' }),
]

const current = (source: CurrentOutput['source']): CurrentOutput => ({
  ref: 'acme/app#9',
  title: 'Done',
  displayState: { state: 'closed' },
  agentSessionId: source === 'run' ? 's-1' : null,
  source,
})

test('the open Tasks to attach to are listed newest tracked first, for a Tab in no Task or only in a Bench', () => {
  const newestFirst = ['acme/app#3', 'acme/app#2', 'acme/app#1']

  expect(attachChoices(tracked, null)?.map((t) => t.ref)).toEqual(newestFirst)
  expect(attachChoices(tracked, current('bench'))?.map((t) => t.ref)).toEqual(newestFirst)
})

test('a Tab whose claude is a Run of a Task, closed or not, has nothing to attach to', () => {
  expect(attachChoices(tracked, current('run'))).toBeNull()
})
