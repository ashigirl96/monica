import { Database } from 'bun:sqlite'
import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { createChatAgent, migrations as chatMigrations } from '@monica/chat/server'
import {
  createJobLedger,
  migrations as jobMigrations,
  router as jobRouter,
} from '@monica/job/server'
import {
  createNoteLedger,
  migrations as noteMigrations,
  systemJobs as noteSystemJobs,
} from '@monica/note/server'
import {
  createTaskLedger,
  migrations as taskMigrations,
  nameAgentSession,
  router as taskRouter,
  systemJobs as taskSystemJobs,
} from '@monica/task/server'
import {
  createWorkbenchLedger,
  migrations as workbenchMigrations,
  router as workbenchRouter,
} from '@monica/workbench/server'
import { os } from '@orpc/server'
import { RPCHandler } from '@orpc/server/fetch'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { Hono } from 'hono'
import { bearerAuth } from 'hono/bearer-auth'
import { cors } from 'hono/cors'

import { listenBrowser } from './browser-listener.ts'
import { loginShellPath } from './login-shell-path.ts'

// stdout は Shell 宛ての JSON 行だけを書く channel なので、log は stderr に出す。
const announce = (line: object) => console.log(JSON.stringify(line))

try {
  process.env.PATH = loginShellPath()
} catch (error) {
  console.error(`[backend] keeping the PATH it started with: ${(error as Error).message}`)
}

const ptydPath = process.env.MONICA_PTYD_PATH
if (!ptydPath) {
  console.error('[backend] MONICA_PTYD_PATH is not set; it names the monica-ptyd to spawn')
  process.exit(1)
}
const home = process.env.MONICA_HOME || join(homedir(), '.monica')
mkdirSync(home, { recursive: true, mode: 0o700 })
chmodSync(home, 0o700)

const sqlite = new Database(join(home, 'monica.db'))
// EXCLUSIVE を WAL より先にすると WAL-index が heap に載り、2 つ目の Backend は最初のクエリで SQLITE_BUSY になって落ちる。
sqlite.run('PRAGMA locking_mode = EXCLUSIVE')
sqlite.run('PRAGMA journal_mode = WAL')
sqlite.run('PRAGMA foreign_keys = ON')
const db = drizzle(sqlite)

for (const m of [
  workbenchMigrations,
  taskMigrations,
  jobMigrations,
  noteMigrations,
  chatMigrations,
]) {
  migrate(db, { migrationsFolder: m.folder, migrationsTable: m.table })
}

const workbenchLedger = createWorkbenchLedger({
  db,
  home,
  ptydPath,
  notify: ({ title, body, terminalSessionId }) =>
    announce({ type: 'notify', title, body, terminalSessionId }),
  nameAgentSession,
  unread: (terminalSessionIds) => announce({ type: 'unread', terminalSessionIds }),
})
const taskLedger = createTaskLedger({ db, workbenchLedger, home })
const noteLedger = createNoteLedger({ db, home })
const jobLedger = createJobLedger({
  db,
  home,
  systemJobs: [...taskSystemJobs(taskLedger), ...noteSystemJobs(noteLedger)],
})
const chatAgent = createChatAgent({ home })

const context = { db, workbenchLedger, taskLedger, jobLedger }
const router = os
  .$context<typeof context>()
  .router({ workbench: workbenchRouter, task: taskRouter, job: jobRouter })
const handler = new RPCHandler(router)

const origins = ['tauri://localhost', 'http://tauri.localhost']
// dev の webview は vite から読まれ、vite の port は home ごとに変わる。
if (process.env.MONICA_DEV_URL) origins.push(new URL(process.env.MONICA_DEV_URL).origin)

const token = crypto.randomUUID()
const startedAt = new Date().toISOString()
const app = new Hono()
app.use('*', cors({ origin: origins }))
app.get('/health', (c) => c.json({ name: 'monica-backend', pid: process.pid, startedAt }))
app.use('/rpc/*', bearerAuth({ token }))
app.use('/rpc/*', async (c, next) => {
  const { matched, response } = await handler.handle(c.req.raw, { prefix: '/rpc', context })
  if (matched) return c.newResponse(response.body, response)
  return next()
})
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, fetch: app.fetch })

// reconcile の前の Terminal Session を webview と CLI に読ませないため、endpoint は Workbench Ledger の start() の後に出す。
// ptyd が起きないときに Backend ごと届かなくならないよう、待つのは 3 秒まで。
const workbenchStarted = workbenchLedger.start().then(() => true)
taskLedger.start()
jobLedger.start()
noteLedger.start()
// compiled binary の --asset は entry の隣に置かれ、bun run の Backend には無い。
const browserListener = listenBrowser(process.env.MONICA_BROWSER_PORT, {
  context: { db, noteLedger, chatAgent },
  webDist: join(import.meta.dir, 'dist'),
})
if (!(await Promise.race([workbenchStarted, Bun.sleep(3000).then(() => false)]))) {
  console.error('[backend] monica-ptyd is not ready after 3s; announcing the endpoint anyway')
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
  browserListener?.stop()
  chatAgent.stop()
  noteLedger.stop()
  jobLedger.stop()
  taskLedger.stop()
  workbenchLedger.stop()
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
