import type { SnapshotEvent, Unreadable } from '../contract.ts'

const UNREADABLE: Record<Unreadable['reason'], string> = {
  restricted: 'このページは Chrome Extension から読めません',
  timeout: '3 秒以内に応えませんでした',
  'too-large': '大きすぎます',
  'fetch-failed': 'PDF を取得できませんでした',
  unparsable: '本文を取り出せませんでした',
}

/**
 * 質問の吹き出しの下に出す 1 行。読めなかった・撮れなかった・切り詰めた・渡していない、の順につなぐ。
 * 同じページだったことは知らせない。
 */
export function noticeOf({ page, omitted }: SnapshotEvent): string | undefined {
  const { content, selection, screenshotFailed } = page
  const cut = [
    ...(content?.kind === 'text' && content.truncated ? ['本文'] : []),
    ...(selection?.truncated ? ['選択範囲'] : []),
  ]
  const left = omitted.pages + omitted.turns
  const parts = [
    ...(content?.kind === 'unreadable'
      ? [`ページを読めませんでした（${UNREADABLE[content.reason]}）`]
      : []),
    ...(screenshotFailed ? ['スクリーンショットを撮れませんでした'] : []),
    ...(cut.length > 0 ? [`${cut.join('と')}を切り詰めました`] : []),
    ...(left > 0 ? [`古いページや問答 ${left} 件を渡していません`] : []),
  ]
  return parts.length > 0 ? parts.join('。') : undefined
}
