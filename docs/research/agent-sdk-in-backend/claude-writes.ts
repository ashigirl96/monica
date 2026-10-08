// marker より後に ~/.claude の下で変わった file のうち、probe の cwd（r257）を中身か path に含むものを探す。読むだけ。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const marker = statSync(join(import.meta.dir, 'marker-start')).mtimeMs
const root = join(process.env.HOME!, '.claude')
const hits: string[] = []
let newer = 0

function walk(dir: string, depth: number) {
  if (depth > 6) return
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    const path = join(dir, name)
    let st
    try {
      st = statSync(path)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      if (path.includes('r257')) hits.push(`${path}/ (dir)`)
      walk(path, depth + 1)
    } else if (st.mtimeMs > marker) {
      newer++
      if (path.includes('r257')) hits.push(path)
      else if (st.size < 5_000_000) {
        try {
          if (readFileSync(path, 'utf8').includes('scratchpad/r257')) hits.push(path)
        } catch {}
      }
    }
  }
}

walk(root, 0)
console.log(JSON.stringify({ newerFiles: newer, mentioningR257: hits }, null, 2))
