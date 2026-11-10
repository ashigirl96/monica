import './fluid/typeset.css'
import './markdown.css'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

export type { Components }

const defaults: Components = {
  // agent が書いた文に埋めた画像の URL を読み込むと、URL に載せた中身が外へ出るので、画像は文字で出す。
  img: ({ alt, src }) => (
    <span className="rounded bg-muted px-1 text-muted-foreground">
      [画像: {alt}] {src}
    </span>
  ),
  table: ({ children }) => (
    <div className="typeset-scroll">
      <table>{children}</table>
    </div>
  ),
}

export function Markdown({ text, components }: { text: string; components?: Components }) {
  return (
    <div className="typeset">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ ...defaults, ...components }}>
        {text}
      </ReactMarkdown>
    </div>
  )
}
