import { join } from 'node:path'

import journal from './chat/meta/_journal.json'

// table が 0 本の journal（entries: []）を tsc は never[] と推論するので型を付ける。
const entries: { tag: string }[] = journal.entries

export const migrations = {
  folder: join(import.meta.dir, 'chat'),
  table: '__drizzle_migrations_chat',
  latest: entries.at(-1)?.tag,
}
