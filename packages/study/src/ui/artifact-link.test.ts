import { expect, test } from 'bun:test'

import { artifactLinkTarget } from './artifact-link.ts'

test('a relative link resolves from the dir of the open file', () => {
  expect(artifactLinkTarget('MISSION.md', 'learning-records/0001-x.md')).toBe(
    'learning-records/0001-x.md',
  )
  expect(artifactLinkTarget('learning-records/0001-x.md', '../GLOSSARY.md')).toBe('GLOSSARY.md')
  expect(artifactLinkTarget('learning-records/0001-x.md', './0002-y.md')).toBe(
    'learning-records/0002-y.md',
  )
})

test('the fragment and the query are dropped', () => {
  expect(artifactLinkTarget('MISSION.md', 'GLOSSARY.md#節')).toBe('GLOSSARY.md')
  expect(artifactLinkTarget('MISSION.md', 'GLOSSARY.md?q=1#a')).toBe('GLOSSARY.md')
})

test('a link out of the Study dir, an absolute path or only a fragment is null', () => {
  expect(artifactLinkTarget('MISSION.md', '../../x')).toBeNull()
  expect(artifactLinkTarget('learning-records/0001-x.md', '../../x')).toBeNull()
  expect(artifactLinkTarget('MISSION.md', '/x')).toBeNull()
  expect(artifactLinkTarget('MISSION.md', '#節')).toBeNull()
})
