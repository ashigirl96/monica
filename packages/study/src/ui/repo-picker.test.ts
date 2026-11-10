import { expect, test } from 'bun:test'

import { typedRepoItem, unlinkedCandidates } from './repo-picker.ts'

const candidates = ['acme/alpha', 'acme/gamma']
const linked = ['Acme/Beta']

test('a typed owner/repo that is neither a candidate nor linked becomes an item to link', () => {
  expect(typedRepoItem('acme/delta', candidates, linked)).toEqual({
    key: 'acme/delta',
    label: 'acme/delta を紐付ける（Repo の一覧に無い）',
  })
})

test('a typed text that is not owner/repo, or names a candidate or a linked Repo in any case, adds no item', () => {
  for (const query of ['', 'acme', 'acme/alpha/x', 'github.com/acme/alpha', 'acme/al pha']) {
    expect(typedRepoItem(query, candidates, linked)).toBeNull()
  }
  expect(typedRepoItem('ACME/Alpha', candidates, linked)).toBeNull()
  expect(typedRepoItem('acme/beta', candidates, linked)).toBeNull()
})

test('the candidates leave out the Repos already linked in any case', () => {
  expect(unlinkedCandidates(['acme/alpha', 'acme/beta', 'acme/gamma'], linked)).toEqual([
    'acme/alpha',
    'acme/gamma',
  ])
})
