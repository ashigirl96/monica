// usage: bun orphan.ts <SIGKILL|SIGTERM> <hold-idle|hold-turn> [backendlike] -- <command...>
// 親（probe）を signal で止めた後、claude の子が残るかを時間を追って見る。
const [signal, mode, ...rest] = process.argv.slice(2)
const sep = rest.indexOf('--')
const flags = rest.slice(0, sep)
const command = rest.slice(sep + 1)

const env: Record<string, string> = { ...(process.env as Record<string, string>) }
if (flags.includes('backendlike')) env.R257_BACKENDLIKE = '1'
if (flags.includes('close')) env.R257_BACKENDLIKE = 'close'

const child = Bun.spawn([...command, mode!], { stdout: 'pipe', stderr: 'pipe', env })
const reader = child.stdout.getReader()
let buffered = ''
let ready: { parent: number; children: number[] } | undefined
while (!ready) {
  const { value, done } = await reader.read()
  if (done) throw new Error(`probe exited before ready: ${buffered}`)
  buffered += new TextDecoder().decode(value)
  for (const line of buffered.split('\n')) {
    try {
      const parsed = JSON.parse(line)
      if (parsed.event === 'ready' || parsed.event === 'streaming') ready = parsed
    } catch {}
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const t0 = performance.now()
process.kill(ready.parent, signal as NodeJS.Signals)
const samples: { ms: number; parentAlive: boolean; childrenAlive: number[] }[] = []
const checkpoints =
  mode === 'hold-turn' ? [100, 1000, 2500, 5000, 10000, 20000, 30000, 45000, 60000] : [100, 500, 1000, 2500, 5000]
for (const at of checkpoints) {
  await Bun.sleep(Math.max(0, at - (performance.now() - t0)))
  samples.push({
    ms: at,
    parentAlive: alive(ready.parent),
    childrenAlive: ready.children.filter(alive),
  })
}
console.log(JSON.stringify({ signal, mode, flags, parent: ready.parent, children: ready.children, samples }))
for (const pid of ready.children.filter(alive)) process.kill(pid, 'SIGKILL')
