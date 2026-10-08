import './fluid/typeset.css'
import './answer.css'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

function openableHost(href: string | undefined): string | undefined {
  if (!href) return undefined
  try {
    const url = new URL(href)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.host : undefined
  } catch {
    return undefined
  }
}

const components: Components = {
  // 答えに埋めた画像の URL を読み込むと、URL に載せた Chat の中身が外へ出るので、画像は文字で出す。
  img: ({ alt, src }) => (
    <span className="rounded bg-muted px-1 text-muted-foreground">
      [画像: {alt}] {src}
    </span>
  ),
  // javascript: などのスクリプトを動かす URL は押せる形にしない。target の無い <a> は side panel から開かない。
  a: ({ href, children }) => {
    const host = openableHost(href)
    if (!host) return <span>{children}</span>
    return (
      <>
        <a href={href} target="_blank" rel="noreferrer">
          {children}
        </a>{' '}
        <span className="text-muted-foreground">{host}</span>
      </>
    )
  },
  table: ({ children }) => (
    <div className="typeset-scroll">
      <table>{children}</table>
    </div>
  ),
}

export function Answer({ text }: { text: string }) {
  return (
    <div className="typeset">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </Markdown>
    </div>
  )
}
