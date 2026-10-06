// Backend の再起動（bun --watch で約 100ms）で帯がちらつかないよう、届かないのが続いたときだけ出す。
const NOTICE_AFTER_MS = 1000
const PROBE_EVERY_MS = 1000

/** notes の口に request が届いているか。link が request ごとに reached か failed を知らせる。 */
export class Reach {
  #failingSince: number | null = null
  #unreachable = false
  #timer: ReturnType<typeof setTimeout> | null = null
  #probe: (() => Promise<unknown>) | null = null
  #listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  isUnreachable = (): boolean => this.#unreachable

  // 届かない間は画面の操作が request を出すとは限らないので、戻ったことを自分で確かめに行く。
  watch(probe: () => Promise<unknown>): () => void {
    this.#probe = probe
    return () => {
      if (this.#probe === probe) this.#probe = null
    }
  }

  reached(): void {
    this.#failingSince = null
    if (this.#timer !== null) clearTimeout(this.#timer)
    this.#timer = null
    this.#set(false)
  }

  failed(): void {
    const now = Date.now()
    if (this.#failingSince === null) this.#failingSince = now
    else if (now - this.#failingSince >= NOTICE_AFTER_MS) this.#set(true)
    this.#timer ??= setTimeout(() => this.#runProbe(), PROBE_EVERY_MS)
  }

  #runProbe(): void {
    this.#timer = null
    if (this.#failingSince === null || this.#probe === null) return
    // 結果は link が reached か failed で知らせるので、ここでは捨てる。
    this.#probe().catch(() => {})
  }

  #set(unreachable: boolean): void {
    if (this.#unreachable === unreachable) return
    this.#unreachable = unreachable
    for (const listener of this.#listeners) listener()
  }
}
