import { expect, test } from 'bun:test'

import { localIso, localTime } from './local-time.ts'

// bun test は TZ を UTC にするので、UTC のままでは UTC の時刻で書く誤りも通る。
test('localTime writes the date and the time of the local time zone', () => {
  const tz = process.env.TZ
  process.env.TZ = 'Asia/Tokyo'
  try {
    expect(localTime(new Date(Date.UTC(2026, 9, 13, 15, 4, 5)))).toBe('2026-10-14 00:04:05')
  } finally {
    process.env.TZ = tz ?? 'UTC'
  }
})

test('localIso writes the local time with its offset from UTC', () => {
  const tz = process.env.TZ
  const at = new Date(Date.UTC(2026, 9, 13, 15, 4, 5))
  try {
    process.env.TZ = 'Asia/Tokyo'
    expect(localIso(at)).toBe('2026-10-14T00:04:05+09:00')
    process.env.TZ = 'America/St_Johns'
    expect(localIso(at)).toBe('2026-10-13T12:34:05-02:30')
  } finally {
    process.env.TZ = tz ?? 'UTC'
  }
})
