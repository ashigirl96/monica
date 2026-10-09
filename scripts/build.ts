import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

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
// domain の package を足しても並べ直さずに済むよう、journal のある migrations folder をすべて同梱する。
const migrations = [
  ...new Bun.Glob('packages/*/migrations/*/meta/_journal.json').scanSync({ cwd: repo }),
].map((journal) => dirname(dirname(journal)))

// bun の isolated linker では pdfjs-dist を packages/chat からしか解けない。
const cMaps = join(
  dirname(Bun.resolveSync('pdfjs-dist/package.json', join(repo, 'packages/chat'))),
  'cmaps',
)
// Backend は --asset の folder を basename で引く（apps/web/dist は dist、pdfjs-dist/cmaps は cmaps）。
const assets = [...migrations, 'apps/web/dist', cMaps]
// compile した binary の Worker は build の entrypoint に要る。main.ts の隣に置くと、main.ts の import.meta.url から同じ相対 path で引ける。
const backendEntrypoints = ['apps/backend/src/main.ts', 'apps/backend/src/pdf-worker.ts']

mkdirSync(binaries, { recursive: true })
await $`cargo build --release -p monica-ptyd`.cwd(repo)
copyFileSync(join(repo, 'target/release/monica-ptyd'), binary('monica-ptyd'))
await $`bun run --cwd apps/web build`.cwd(repo)
// Chrome Extension は Backend に同梱せず、install-app が .app の Contents/Resources/extension に写す。
await $`bun run --cwd apps/extension build`.cwd(repo)
await $`bun build ${compile} ${assets.flatMap((dir) => ['--asset', dir])} ${backendEntrypoints} --outfile ${binary('monica-backend')}`.cwd(
  repo,
)
await $`bun build ${compile} apps/cli/src/main.ts --outfile ${binary('monica')}`.cwd(repo)

// externalBin は release の build にだけ渡す。base の config に書くと、tauri-build が dev と clippy でも
// binaries/ の存在を求め、build のたびに target/debug/monica-ptyd をそこからのコピーで上書きする。
const release = {
  bundle: { externalBin: ['binaries/monica-ptyd', 'binaries/monica-backend', 'binaries/monica'] },
}
await $`bun run tauri build --bundles app --config ${JSON.stringify(release)}`.cwd(
  join(repo, 'apps/desktop'),
)
