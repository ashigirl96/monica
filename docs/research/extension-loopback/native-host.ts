// Native Messaging の host。届いた message ごとに、起こされた引数と環境を返す。
// browser は host を PATH の短い env で起こすので、manifest の path には bun を絶対 path で呼ぶ wrapper を書く。
const write = (message: object) => {
  const body = Buffer.from(JSON.stringify(message))
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.length)
  process.stdout.write(Buffer.concat([header, body]))
}

let pending = Buffer.alloc(0)
for await (const chunk of Bun.stdin.stream()) {
  pending = Buffer.concat([pending, chunk])
  while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32LE(0)) {
    const length = pending.readUInt32LE(0)
    const message = JSON.parse(pending.subarray(4, 4 + length).toString())
    pending = pending.subarray(4 + length)
    write({
      received: message,
      argv: process.argv.slice(2),
      pid: process.pid,
      ppid: process.ppid,
      cwd: process.cwd(),
      path: process.env.PATH,
    })
  }
}
