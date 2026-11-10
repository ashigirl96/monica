import { rmSync } from 'node:fs'
import { join } from 'node:path'

// release の同梱は /$bunfs にあるので、browser listener が SPA を配るのと同じく Bun.Glob で並べて Bun.file で読む。
export async function writeTutors(from: string, to: string): Promise<string> {
  rmSync(to, { recursive: true, force: true })
  for (const path of new Bun.Glob('**/*').scanSync({ cwd: from })) {
    await Bun.write(join(to, path), Bun.file(join(from, path)))
  }
  return to
}
