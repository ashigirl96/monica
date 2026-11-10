import { join } from 'node:path'

import journal from './study/meta/_journal.json'

// table が 0 本の journal（entries: []）を tsc は never[] と推論するので型を付ける。
const entries: { tag: string }[] = journal.entries

export const migrations = {
  folder: join(import.meta.dir, 'study'),
  table: '__drizzle_migrations_study',
  // journal の import は、generate の出力を bun --watch の import 木に入れるためにある。
  latest: entries.at(-1)?.tag,
}
