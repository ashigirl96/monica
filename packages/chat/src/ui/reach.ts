import { isUnreachable } from './failure.ts'

const PROBE_EVERY_MS = 5000

export type Reach = {
  unreachable: () => boolean
  /** probe を呼び、届かなければ帯を出して確かめ直しを始める。 */
  check: () => void
  /** Backend に届かなかった。 */
  failed: () => void
  /** Backend に届いた。error の応答でも届いている。 */
  reached: () => void
  /** 確かめ直しを止め、この後に返る probe の結果も捨てる。 */
  dispose: () => void
}

/**
 * Backend に届くかを見張る。届かない間だけ、5 秒おきと focus で probe を呼び、届いたら止める。
 * 帯を出している間しか呼ばないので、Backend の再起動（bun --watch で約 100ms）で帯がちらつくことは無く、待たずに出す。
 */
export function watchReach(
  probe: () => Promise<unknown>,
  focus: EventTarget,
  onChange: () => void,
): Reach {
  let unreachable = false
  let disposed = false
  let timer: ReturnType<typeof setInterval> | undefined

  const stopChecking = () => {
    clearInterval(timer)
    timer = undefined
    focus.removeEventListener('focus', check)
  }

  function check() {
    probe().then(reached, (error: unknown) => (isUnreachable(error) ? failed() : reached()))
  }

  function failed() {
    if (disposed || unreachable) return
    unreachable = true
    timer = setInterval(check, PROBE_EVERY_MS)
    focus.addEventListener('focus', check)
    onChange()
  }

  function reached() {
    if (disposed || !unreachable) return
    unreachable = false
    stopChecking()
    onChange()
  }

  return {
    unreachable: () => unreachable,
    check,
    failed,
    reached,
    dispose() {
      disposed = true
      stopChecking()
    },
  }
}
