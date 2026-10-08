// PROTOTYPE: 普段の profile に入れず、捨てる user-data-dir の Brave に dev の拡張を読み込ませる。
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const brave = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
const dist = resolve(import.meta.dir, '../dist')
const profile = join(import.meta.dir, '../.brave-profile')
mkdirSync(profile, { recursive: true })

Bun.spawn(
  [
    brave,
    `--user-data-dir=${profile}`,
    `--load-extension=${dist}`,
    '--no-first-run',
    '--no-default-browser-check',
    'https://ja.wikipedia.org/wiki/サイドパネル',
  ],
  { stdio: ['ignore', 'ignore', 'ignore'] },
).unref()
