import { Defuddle } from 'defuddle/node'
import { parseHTML } from 'linkedom'

// defuddle の link rule が書く `[text](href "title")`。href の ( ) は \( \)、空白を含む href は <…> になる。
const LINK = String.raw`\[((?:\\.|[^\\\]])*)\]\((?:<(?:\\.|[^\\>])*>|(?:\\.|[^\\\s()])*)(?:\s+"(?:\\.|[^\\"])*")?\)`
const MARKDOWN_LINK = new RegExp(String.raw`(?<!\\)${LINK}`, 'g')
// removeImages は img を消すが、picture の source は turndown が Markdown の画像にする。
const MARKDOWN_IMAGE = new RegExp(String.raw`(?<!\\)!${LINK}`, 'g')
// 属性の値に > を含んでも tag の終わりと読まない。
const ATTRIBUTES = String.raw`(?:[^>"']|"[^"]*"|'[^']*')*`
const RAW_A_TAG = new RegExp(String.raw`<a\b${ATTRIBUTES}>|</a\s*>`, 'gi')
const RAW_MEDIA = new RegExp(
  String.raw`<(iframe|video|audio)\b${ATTRIBUTES}>[\s\S]*?</\1\s*>|<(?:iframe|video|audio)\b${ATTRIBUTES}>`,
  'gi',
)

/** 画像を落とし、リンクは URL を落として文字だけを残す。turndown が生の HTML のまま残した表や sup の中の a も、tag だけを外す。 */
function withoutLinksAndImages(markdown: string): string {
  return markdown
    .replace(RAW_MEDIA, '')
    .replace(RAW_A_TAG, '')
    .replace(MARKDOWN_IMAGE, '')
    .replace(MARKDOWN_LINK, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** getHTML が書き出した document element の中身を、リンクの URL を落とした Markdown の本文にする。 */
export async function pageText(html: string, url: string | undefined): Promise<string> {
  // getHTML は document element の中身だけを返す。
  const { document } = parseHTML(`<!doctype html><html>${html}</html>`)
  // useAsync: false で、本文の無いページに第三者の API を呼ばせない。
  const { content } = await Defuddle(document as unknown as Document, url, {
    markdown: true,
    useAsync: false,
    removeImages: true,
  })
  return withoutLinksAndImages(content)
}
