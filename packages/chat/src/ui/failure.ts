import { ORPCError } from '@orpc/client'

import { askErrors, type UsageEvent } from '../contract.ts'
import { BackendUnreachable } from './native-host.ts'

/** 答えの場所に出す失敗。line は 1 行目、detail は CLI の原文などを出す詳しい行。 */
export type Failure = { line: string; detail?: string }

/**
 * その質問で受けたもの。code だけでは「途中で切れた」「API に繋がらない」「起きない」を分けられないため。
 * reached は chat.ask の応答が届いたこと。
 */
export type Seen = { answer: string; retried: boolean; reached: boolean }

const CUT_OFF = '答えが途中で切れました'
const NO_ANSWER = 'claude が答えを返せませんでした'

// CLI が版ごとに値を足すので、知らない値は呼び名を付けずに「plan の」だけにする。
const LIMIT_NAMES: Record<string, string> = {
  five_hour: 'plan の 5 時間の',
  seven_day: 'plan の週の',
  seven_day_opus: 'plan の Opus の週の',
  seven_day_sonnet: 'plan の Sonnet の週の',
}

const limitName = (rateLimitType: string) => LIMIT_NAMES[rateLimitType] ?? 'plan の'

/**
 * Chromium の fetch は、Backend の居ない port でも、stream の途中で Backend が落ちても TypeError を投げる。
 * Native Messaging の host が Backend を引けないときと、起き直した Backend が古い Chrome Extension の token を 401 で断ったときも同じに数える。
 */
export function isUnreachable(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    error instanceof BackendUnreachable ||
    (error instanceof ORPCError && error.code === 'UNAUTHORIZED')
  )
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** resetsAt（unix 秒）を side panel が動く Mac の時刻で、今日なら時刻だけ、別の日なら日付も付けて書く。 */
function clock(resetsAt: number, now: Date): string {
  const at = new Date(resetsAt * 1000)
  const time = `${at.getHours()}:${String(at.getMinutes()).padStart(2, '0')}`
  const today =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate()
  return today ? time : `${at.getMonth() + 1}月${at.getDate()}日 ${time}`
}

export function retryingLine(attempt: number): string {
  return `Anthropic の API に繋がりません。再試行しています（${attempt} 回目）`
}

export function usageLine({ utilization, rateLimitType, resetsAt }: UsageEvent, now: Date): string {
  const used = `${limitName(rateLimitType)}枠を ${Math.round(utilization * 100)}% 使いました`
  return resetsAt === undefined ? used : `${used}（${clock(resetsAt, now)} に戻ります）`
}

/** Backend の message は出さず、code と data から日本語の文を作る。 */
export function failureOf(error: unknown, seen: Seen, now: Date): Failure {
  if (isUnreachable(error)) {
    return { line: seen.reached ? CUT_OFF : 'monica の desktop に届きませんでした' }
  }
  if (!(error instanceof ORPCError)) return { line: NO_ANSWER, detail: messageOf(error) }
  switch (error.code) {
    case 'NOT_AUTHENTICATED':
      return {
        line: 'Claude Code に login していません。terminal で claude を起こし、/login してください',
      }
    case 'CHAT_BUSY':
      return { line: 'ほかの Chat が答えています' }
    case 'USAGE_LIMIT': {
      const limit = askErrors.USAGE_LIMIT.data.safeParse(error.data)
      if (!limit.success) break
      const { rateLimitType, resetsAt } = limit.data
      return {
        line: `${limitName(rateLimitType)}上限に達しました。${clock(resetsAt, now)} に戻ります`,
      }
    }
    case 'AGENT_FAILED': {
      const failed = askErrors.AGENT_FAILED.data.safeParse(error.data)
      if (!failed.success) break
      const line = seen.answer
        ? CUT_OFF
        : seen.retried
          ? 'Anthropic の API に繋がりませんでした'
          : NO_ANSWER
      return { line, detail: failed.data.detail }
    }
  }
  return { line: NO_ANSWER, detail: `${error.code}: ${error.message}` }
}
