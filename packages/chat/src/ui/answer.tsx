import { type Components, Markdown } from '@monica/ui/markdown'

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
}

export function Answer({ text }: { text: string }) {
  return <Markdown text={text} components={components} />
}
