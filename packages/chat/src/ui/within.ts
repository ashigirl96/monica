/** ms のうちに決まらなければ 'timeout' にする。相手が応えなくても、その終わりを待たない。 */
export async function within<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** signal が abort したら、その reason で reject する。相手が signal に応えなくても、その終わりを待たない。 */
export function unlessAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let stop: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    stop = () => reject(signal.reason)
    if (signal.aborted) stop()
    else signal.addEventListener('abort', stop, { once: true })
  })
  return Promise.race([promise, aborted]).finally(() => {
    if (stop) signal.removeEventListener('abort', stop)
  })
}
