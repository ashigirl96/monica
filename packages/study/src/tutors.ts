import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

// release の同梱は /$bunfs にあるので、browser listener が SPA を配るのと同じく Bun.Glob で並べて Bun.file で読む。
export async function writeTutors(from: string, to: string): Promise<string> {
  rmSync(to, { recursive: true, force: true })
  for (const path of new Bun.Glob('**/*').scanSync({ cwd: from })) {
    await Bun.write(join(to, path), Bun.file(join(from, path)))
  }
  return to
}

// compiled binary は --asset の tutors を /$bunfs に持ち、Backend が起こす claude からは読めないので home に書き出す。
export async function installTutors(bundled: string, home: string): Promise<string | undefined> {
  if (!existsSync(bundled)) return undefined
  try {
    return await writeTutors(bundled, join(home, 'tutors'))
  } catch (error) {
    // Study の turn は失敗を turn-ended に出し、Workbench・Task・Note は動く。
    console.error(`[study] could not write the Tutors: ${(error as Error).message}`)
    return undefined
  }
}
