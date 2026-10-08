import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

// 回答に埋めた画像の URL を読み込むと、URL に載せた会話が外へ出るので、画像は文字で出す。
const components: Components = {
  img: ({ alt, src }) => (
    <span className="rounded bg-muted px-1 text-muted-foreground">
      [画像: {alt}] {String(src ?? '')}
    </span>
  ),
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="typeset-scroll">
      <table>{children}</table>
    </div>
  ),
}

export function Answer({ text, className }: { text: string; className?: string }) {
  return (
    <div className={className}>
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </Markdown>
    </div>
  )
}
