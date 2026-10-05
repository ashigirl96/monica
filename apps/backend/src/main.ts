import { Database } from 'bun:sqlite'
import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { os } from '@orpc/server'
import { RPCHandler } from '@orpc/server/fetch'
import {
  createTask,
  migrations as taskMigrations,
  nameAgentSession,
  router as taskRouter,
} from '@tania/task/server'
import {
  createWorkbench,
  migrations as workbenchMigrations,
  router as workbenchRouter,
} from '@tania/workbench/server'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { Hono } from 'hono'
import { bearerAuth } from 'hono/bearer-auth'
import { cors } from 'hono/cors'

import { loginShellPath } from './login-shell-path.ts'

// stdout は Shell 宛ての JSON 行だけを書く channel なので、log は stderr に出す。
const announce = (line: object) => console.log(JSON.stringify(line))

try {
  process.env.PATH = loginShellPath()
} catch (error) {
  console.error(`[backend] keeping the PATH it started with: ${(error as Error).message}`)
}

const ptydPath = process.env.TANIA_PTYD_PATH
if (!ptydPath) {
  console.error('[backend] TANIA_PTYD_PATH is not set; it names the tania-ptyd to spawn')
  process.exit(1)
}
const home = process.env.TANIA_HOME || join(homedir(), '.tania')
mkdirSync(home, { recursive: true, mode: 0o700 })
chmodSync(home, 0o700)

const sqlite = new Database(join(home, 'tania.db'))
// EXCLUSIVE を WAL より先にすると WAL-index が heap に載り、2 つ目の Backend は最初のクエリで SQLITE_BUSY になって落ちる。
sqlite.run('PRAGMA locking_mode = EXCLUSIVE')
sqlite.run('PRAGMA journal_mode = WAL')
sqlite.run('PRAGMA foreign_keys = ON')
const db = drizzle(sqlite)

for (const m of [workbenchMigrations, taskMigrations]) {
  migrate(db, { migrationsFolder: m.folder, migrationsTable: m.table })
}

const workbench = createWorkbench({
  db,
  home,
  ptydPath,
  notify: ({ title, body }) => announce({ type: 'notify', title, body }),
  nameAgentSession,
})
const task = createTask({ db, workbench, home })

const context = { db, workbench, task }
const router = os
  .$context<typeof context>()
  .router({ workbench: workbenchRouter, task: taskRouter })
const handler = new RPCHandler(router)

const origins = ['tauri://localhost', 'http://tauri.localhost']
// dev の webview は vite から読まれ、vite の port は home ごとに変わる。
if (process.env.TANIA_DEV_URL) origins.push(new URL(process.env.TANIA_DEV_URL).origin)

const token = crypto.randomUUID()
const startedAt = new Date().toISOString()
const app = new Hono()
app.use('*', cors({ origin: origins }))
app.get('/health', (c) => c.json({ name: 'tania-backend', pid: process.pid, startedAt }))
app.use('/rpc/*', bearerAuth({ token }))
app.use('/rpc/*', async (c, next) => {
  const { matched, response } = await handler.handle(c.req.raw, { prefix: '/rpc', context })
  if (matched) return c.newResponse(response.body, response)
  return next()
})
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, fetch: app.fetch })

// reconcile の前の Terminal Session を webview と CLI に読ませないため、endpoint は workbench の start() の後に出す。
// ptyd が起きないときに Backend ごと届かなくならないよう、待つのは 3 秒まで。
const workbenchStarted = workbench.start().then(() => true)
task.start()
if (!(await Promise.race([workbenchStarted, Bun.sleep(3000).then(() => false)]))) {
  console.error('[backend] tania-ptyd is not ready after 3s; announcing the endpoint anyway')
}

const endpointPath = join(home, 'backend.json')
const endpointTmp = `${endpointPath}.${process.pid}.tmp`
writeFileSync(
  endpointTmp,
  `${JSON.stringify({ port: server.port, token, pid: process.pid, startedAt })}\n`,
  { mode: 0o600 },
)
renameSync(endpointTmp, endpointPath)
announce({ type: 'endpoint', port: server.port, token })
console.error(`[backend] listening on 127.0.0.1:${server.port}`)

let exiting = false
function exit() {
  if (exiting) return
  exiting = true
  task.stop()
  workbench.stop()
  try {
    unlinkSync(endpointPath)
  } catch {
    // 既に無い。
  }
  void server.stop(true)
  sqlite.close()
  process.exit(0)
}
process.on('SIGTERM', exit)
// Shell は stdin の write 側を握ったまま何も書かないので、EOF は親が死んだ合図になる。ppid は EOF の取りこぼしの保険。
process.stdin.on('end', exit)
process.stdin.resume()
setInterval(() => {
  if (process.ppid === 1) exit()
}, 1000)
