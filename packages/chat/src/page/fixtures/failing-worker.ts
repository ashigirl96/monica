import { replyWithText } from '../worker.ts'

// defuddle は自分の失敗を握って body 全体を返すので、本文にする途中の例外は本物の HTML では作れない。
replyWithText(() => Promise.reject(new Error('the parser broke')))
