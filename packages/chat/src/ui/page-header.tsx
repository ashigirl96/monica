import type { Page } from '../contract.ts'
import { Button } from './fluid/button.tsx'
import { useIcons } from './fluid/lib/icon-context.tsx'

// file: のように host の無い URL は、URL をそのまま出す。
function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

function PageLines({ page: { url, title } }: { page: Page }) {
  if (url === undefined && title === undefined) {
    return (
      <div className="truncate text-[13px] leading-5 text-muted-foreground">読めないページ</div>
    )
  }
  return (
    <>
      <div className="truncate text-[13px] leading-5 text-foreground">{title ?? url}</div>
      {url !== undefined && (
        <div className="truncate text-[11px] leading-4 text-muted-foreground" title={url}>
          {hostOf(url)}
        </div>
      )}
    </>
  )
}

/** 上端に Current Page の title と host を出し、右端に「新しい Chat」を置く。 */
export function PageHeader({ page, onNewChat }: { page: Page | undefined; onNewChat: () => void }) {
  const icons = useIcons()
  return (
    <header className="flex min-h-[52px] items-center gap-2 border-b border-border px-3 py-2">
      <div className="min-w-0 flex-1">{page && <PageLines page={page} />}</div>
      <Button variant="ghost" size="compact" leadingIcon={icons.plus} onClick={onNewChat}>
        新しい Chat
      </Button>
    </header>
  )
}
