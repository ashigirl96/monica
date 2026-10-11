import { table } from '@monica/ui/table'

import type { ListOutput } from './contract.ts'

export const formatters = {
  // Feature は常にあるので、行が空になることは無い。
  list({ usages }: ListOutput): string {
    return table([
      ['FEATURE', 'CALLER', 'CALLS', 'FAILED', 'LAST USED'],
      ...usages.map((item) => [
        item.feature,
        item.caller ?? '-',
        String(item.ok + item.failed),
        String(item.failed),
        item.lastUsed ?? '-',
      ]),
    ])
  },
}
