type Vars = Record<string, any>

const at = (f: any, i: number | string) => (f ? f[i] : undefined)
const head = (q: any) => at(q, 1)

function tabLabel(v: Vars, slot: 'pinned' | 'plain') {
  const s = v.tab[slot]
  if (!s) return 'no Tab'
  const shell = at(v.sess, s) === 'live' ? 'shell runs' : 'no shell'
  return `${at(v.row, s)}, ${shell}`
}

const BACKEND: Record<string, string> = {
  down: 'reconnecting',
  hello: 'saying hello',
  listing: 'waiting for the List',
  up: 'connected',
}

export const title = 'Workbench books against monica-ptyd'

function hiddenShells(v: Vars) {
  const shown = new Set([v.tab.pinned, v.tab.plain].filter(Boolean).map(String))
  const hidden = Object.entries(v.sess ?? {}).filter(
    ([id, s]) => s === 'live' && !shown.has(id),
  ).length
  return hidden === 0 ? 'none' : `${hidden} running`
}

export const state = (v: Vars) => ({
  Backend: BACKEND[v.bconn] ?? v.bconn,
  'Pinned Tab': tabLabel(v, 'pinned'),
  'Plain Tab': tabLabel(v, 'plain'),
  'Shells no Tab shows': hiddenShells(v),
})

export function step(action: string, from: Vars) {
  switch (action) {
    case 'OpenTab':
      return 'a Tab opens'
    case 'OpenTabRolledBack':
      return 'a Tab opens and the transaction rolls back'
    case 'CloseTab':
      return 'the plain Tab closes'
    case 'RespawnTab':
      return 'you press New shell'
    case 'Flush':
      return `the Backend sends ${head(from.waiting)?.op ?? 'a request'} to ptyd`
    case 'Connect':
      return 'the Backend connects to ptyd'
    case 'HelloDone':
      return 'the Backend asks ptyd for the List'
    case 'Receive': {
      const m = head(from.fromPtyd)
      if (m?.type === 'exit') return 'the Backend hears a shell exit'
      if (m?.type === 'list') return 'the Backend reconciles with the List'
      return `the Backend hears ptyd answer ${m?.op ?? 'a request'}`
    }
    case 'BackendSeesClose':
      return 'the Backend notices the connection closed'
    case 'BackendRestart':
      return 'the Backend restarts'
    case 'PtydServe':
      return `ptyd handles ${head(from.toPtyd)?.op ?? 'a request'}`
    case 'PtydReplies':
      return 'ptyd sends its answer'
    case 'ShellExits':
      return 'a shell exits'
    case 'PtydDropsConn':
      return 'ptyd drops the connection'
    case 'PtydCrash':
      return 'ptyd dies'
    default:
      return action
  }
}
