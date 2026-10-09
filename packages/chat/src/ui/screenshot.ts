import type { Page } from '../contract.ts'
import { messageOf } from './failure.ts'
import { within } from './within.ts'

type Size = { width: number; height: number }

/**
 * 撮った画像の px を side panel の devicePixelRatio で割った大きさ。ページを読めなくても決められる。
 * ページの zoom が 100% でないときは Browser Tab の CSS px とずれる。撮った画像より大きくはしない。
 */
export function shrunkSize({ width, height }: Size, ratio: number): Size {
  const scale = Math.max(ratio, 1)
  return {
    width: Math.max(1, Math.round(width / scale)),
    height: Math.max(1, Math.round(height / scale)),
  }
}

// executeScript と同じく、返らない場面に備える。
const CAPTURE_TIMEOUT_MS = 3000
const JPEG_QUALITY = 0.8

async function shrunkJpeg(png: string): Promise<string> {
  const bitmap = await createImageBitmap(await (await fetch(png)).blob())
  const { width, height } = shrunkSize(bitmap, devicePixelRatio)
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('the canvas has no 2d context')
  context.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY })
  return new Uint8Array(await jpeg.arrayBuffer()).toBase64()
}

/**
 * window の Current Page の Browser Tab の表示領域を撮り、CSS px に縮めた JPEG にする。撮れなければ理由を返す。
 * 呼んだ時に撮り始めるので、送る操作の user gesture の中で呼ぶ。gesture の外では約 1 秒に 2 回で quota にかかる。
 */
export async function takeScreenshot(
  windowId: number | undefined,
): Promise<Pick<Page, 'screenshot' | 'screenshotFailed'>> {
  try {
    // PNG で撮り、縮めた後に 1 度だけ JPEG にして、劣化を 2 度かけない。
    const png = await within(
      windowId === undefined
        ? chrome.tabs.captureVisibleTab({ format: 'png' })
        : chrome.tabs.captureVisibleTab(windowId, { format: 'png' }),
      CAPTURE_TIMEOUT_MS,
    )
    if (png === 'timeout') {
      return { screenshotFailed: { reason: 'the Browser Tab did not answer within 3 seconds' } }
    }
    return { screenshot: await shrunkJpeg(png) }
  } catch (error) {
    return { screenshotFailed: { reason: messageOf(error) } }
  }
}
