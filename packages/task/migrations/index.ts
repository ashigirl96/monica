import { join } from 'node:path'

import journal from './task/meta/_journal.json'

// table が 0 本の journal（entries: []）を tsc は never[] と推論するので型を付ける。
const entries: { tag: string }[] = journal.entries

export const migrations = {
  folder: join(import.meta.dir, 'task'),
  table: '__drizzle_migrations_task',
  // journal の import は、generate の出力を bun --watch の import 木に入れるためにある。
  latest: entries.at(-1)?.tag,
}
