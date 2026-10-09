import { liveEndpoint } from './backend.ts'

/** Chromium が host を起こすときに第 1 引数に渡す、呼んだ Chrome Extension の origin の頭。 */
export const CHROME_EXTENSION_ORIGIN = 'chrome-extension://'

export type NativeHostReply = { port: number; token: string } | { error: 'not-running' }

/**
 * Native Messaging の host として、home の Backend の port と Chrome Extension の token を 1 通で返す。全権の token は渡さない（ADR-0034）。
 * sendNativeMessage は応答を受けてから stdin を閉じるので、EOF を待たずに 1 通だけ読む。
 */
export async function answerChromeExtension(home: string): Promise<number> {
  await readOneMessage(Bun.stdin.stream())
  const endpoint = liveEndpoint(home)
  const reply: NativeHostReply = endpoint?.extensionToken
    ? { port: endpoint.port, token: endpoint.extensionToken }
    : { error: 'not-running' }
  await Bun.write(Bun.stdout, framed(reply))
  return 0
}

// 枠は 4 byte の長さを native byte order（Mac では little-endian）で書き、UTF-8 の JSON を続ける。
function framed(message: NativeHostReply): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(message))
  const frame = new Uint8Array(4 + json.byteLength)
  new DataView(frame.buffer).setUint32(0, json.byteLength, true)
  frame.set(json, 4)
  return frame
}

// 中身は使わないが、Chromium が書き終える前に抜けないよう、届いた 1 通を読み切ってから返す。
async function readOneMessage(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader()
  let received = new Uint8Array(0)
  const complete = () =>
    received.byteLength >= 4 &&
    received.byteLength >= 4 + new DataView(received.buffer).getUint32(0, true)
  while (!complete()) {
    const { value, done } = await reader.read()
    if (done) break
    const joined = new Uint8Array(received.byteLength + value.byteLength)
    joined.set(received)
    joined.set(value, received.byteLength)
    received = joined
  }
  reader.releaseLock()
}
