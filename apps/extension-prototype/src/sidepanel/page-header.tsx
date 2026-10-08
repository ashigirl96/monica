import { cn } from './fluid/lib/utils.ts'

export function PageHeader({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-center gap-2 px-3 py-2', className)}>
      <span className="flex size-5 shrink-0 items-center justify-center rounded bg-foreground text-[11px] text-background">
        W
      </span>
      <div className="min-w-0">
        <div className="truncate text-[13px] leading-5 text-foreground">
          サイドパネル - Wikipedia
        </div>
        <div className="truncate text-[11px] leading-4 text-muted-foreground">
          ja.wikipedia.org/wiki/サイドパネル
        </div>
      </div>
    </div>
  )
}
