import { rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// macOS は新しく書いた実行 file を初めて exec するたびに検査を挟むので、path は repo の 1 つを指す symlink にし、script は隣の `<path>.sh` から sh で読ませる。
export function writeFakeExecutable(path: string, script: string) {
  writeFileSync(`${path}.sh`, `${script}\n`)
  rmSync(path, { force: true })
  symlinkSync(join(import.meta.dir, 'fake-executable.sh'), path)
}
