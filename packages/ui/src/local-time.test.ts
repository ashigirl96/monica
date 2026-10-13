import { expect, test } from 'bun:test'

import { localTime } from './local-time.ts'

// bun test は TZ を UTC にするので、UTC のままでは UTC の時刻で書く誤りも通る。
test('localTime writes the date and the time of the local time zone', () => {
  const tz = process.env.TZ
  process.env.TZ = 'Asia/Tokyo'
  try {
    expect(localTime(new Date(Date.UTC(2026, 9, 13, 15, 4, 5)))).toBe('2026-10-14 00:04:05')
  } finally {
    // bun test は TZ を設定せずに UTC で動き、undefined の代入と delete は手元の時間帯に落ちる。
    process.env.TZ = tz ?? 'UTC'
  }
})
