import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { $ } from 'bun'

const repo = join(import.meta.dir, '..')
const binaries = join(repo, 'apps/desktop/src-tauri/binaries')
const triple = (await $`rustc --print host-tuple`.text()).trim()
const binary = (name: string) => join(binaries, `${name}-${triple}`)

// --minify は trpc-cli の class 名による instanceof を壊す。--bytecode は top-level await のために --format=esm が要る。
const compile = [
  '--compile',
  '--minify-whitespace',
  '--minify-syntax',
  '--bytecode',
  '--format=esm',
]
const migrations = ['packages/workbench/migrations/workbench', 'packages/task/migrations/task']

mkdirSync(binaries, { recursive: true })
await $`cargo build --release -p tania-ptyd`.cwd(repo)
copyFileSync(join(repo, 'target/release/tania-ptyd'), binary('tania-ptyd'))
await $`bun build ${compile} ${migrations.flatMap((dir) => ['--asset', dir])} apps/backend/src/main.ts --outfile ${binary('tania-backend')}`.cwd(
  repo,
)
await $`bun build ${compile} apps/cli/src/main.ts --outfile ${binary('tania')}`.cwd(repo)

// externalBin は release の build にだけ渡す。base の config に書くと、tauri-build が dev と clippy でも
// binaries/ の存在を求め、build のたびに target/debug/tania-ptyd をそこからのコピーで上書きする。
const release = {
  bundle: { externalBin: ['binaries/tania-ptyd', 'binaries/tania-backend', 'binaries/tania'] },
}
await $`bun run tauri build --bundles app --config ${JSON.stringify(release)}`.cwd(
  join(repo, 'apps/desktop'),
)
