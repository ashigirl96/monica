import { pageText } from './page/extract.ts'
import type { HtmlRequest } from './page/html.ts'
import { replyWithText } from './page/worker.ts'

replyWithText(({ html, url }: HtmlRequest) => pageText(html, url))
