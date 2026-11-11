export function localTime(date: Date): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

/** localTime を ISO 8601 の形にし、UTC との差を付ける。 */
export function localIso(date: Date): string {
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  return `${localTime(date).replace(' ', 'T')}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}
