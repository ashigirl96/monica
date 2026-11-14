import { Button } from '@monica/ui/fluid'
import { type Components, Markdown } from '@monica/ui/markdown'
import { useMutation, useQuery } from '@tanstack/react-query'
import { ExternalLink, FileText, Folder, X } from 'lucide-react'

import { artifactLinkTarget } from './artifact-link.ts'
import { FailureLine, useScreen } from './screen.tsx'
import { type Pane, SidePane } from './side-pane.tsx'

export const artifactsKey = (id: string) => ['study', id, 'artifacts']
export const artifactKey = (id: string, path: string) => ['study', id, 'artifact', path]

const TOP_LABELS: Record<string, string> = {
  'MISSION.md': 'Mission',
  'MAP.md': '地図',
  'RESOURCES.md': '一次資料',
  'GLOSSARY.md': '用語集',
  'log.md': '経過の記録',
}
const RECORDS_PREFIX = 'learning-records/'

function linkComponents(from: string, onOpenArtifact: (path: string) => void): Components {
  return {
    a: ({ href, children }) => {
      if (href === undefined) return <>{children}</>
      if (/^https?:\/\//i.test(href)) {
        return (
          <a href={href} target="_blank" rel="noreferrer">
            {children}
          </a>
        )
      }
      const target = /^[a-z][a-z0-9+.-]*:/i.test(href) ? null : artifactLinkTarget(from, href)
      if (target === null) return <>{children}</>
      return (
        <button
          type="button"
          onClick={() => onOpenArtifact(target)}
          className="cursor-pointer text-[color:var(--link,inherit)] underline underline-offset-2"
        >
          {children}
        </button>
      )
    },
  }
}

export function ArtifactContent({
  path,
  content,
  onOpenArtifact,
}: {
  path: string
  content: string
  onOpenArtifact: (path: string) => void
}) {
  if (!path.endsWith('.md')) {
    return <pre className="text-[12px] whitespace-pre-wrap">{content}</pre>
  }
  return <Markdown text={content} components={linkComponents(path, onOpenArtifact)} />
}

function TreeItem({
  label,
  selected,
  onSelect,
}: {
  label: string
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-left text-[13px] ${selected ? 'bg-selected text-foreground' : 'hover:bg-hover text-muted-foreground'}`}
    >
      <FileText className="size-3.5 shrink-0" strokeWidth={1.8} />
      <span className="truncate">{label}</span>
    </button>
  )
}

export function ArtifactTree({
  id,
  selected,
  onSelect,
  pane,
}: {
  id: string
  selected: string | null
  onSelect: (path: string) => void
  pane: Pane
}) {
  const { client } = useScreen()
  const { data } = useQuery({
    queryKey: artifactsKey(id),
    queryFn: () => client.artifact.list({ id }),
  })
  const artifacts = data?.artifacts ?? []
  const top = (name: string) =>
    artifacts.some((artifact) => artifact.path === name) && (
      <TreeItem
        key={name}
        label={TOP_LABELS[name]!}
        selected={selected === name}
        onSelect={() => onSelect(name)}
      />
    )
  const records = artifacts.filter((artifact) => artifact.path.startsWith(RECORDS_PREFIX))
  return (
    <SidePane side="left" label="成果物の一覧" pane={pane} className="gap-0.5 overflow-y-auto p-3">
      <h2 className="mb-1 px-2 text-[12px] text-muted-foreground">成果物</h2>
      {top('MISSION.md')}
      {top('MAP.md')}
      {top('RESOURCES.md')}
      {records.length > 0 && (
        <>
          <span className="flex items-center gap-1.5 px-2 py-1 text-[13px] text-muted-foreground">
            <Folder className="size-3.5" strokeWidth={1.8} />
            学習記録
          </span>
          <div className="flex flex-col gap-0.5 pl-3">
            {records.map(({ path, title }) => (
              <TreeItem
                key={path}
                label={`${path.slice(RECORDS_PREFIX.length, RECORDS_PREFIX.length + 4)} ${title ?? ''}`}
                selected={selected === path}
                onSelect={() => onSelect(path)}
              />
            ))}
          </div>
        </>
      )}
      {top('GLOSSARY.md')}
      {top('log.md')}
    </SidePane>
  )
}

export function ArtifactPanel({
  id,
  dir,
  path,
  onOpenArtifact,
  onClose,
  pane,
}: {
  id: string
  dir: string
  path: string
  onOpenArtifact: (path: string) => void
  onClose: () => void
  pane: Pane
}) {
  const { client } = useScreen()
  const read = useQuery({
    queryKey: artifactKey(id, path),
    queryFn: () => client.artifact.read({ id, path }),
  })
  const open = useMutation({ mutationFn: () => client.artifact.open({ id, path }) })
  return (
    <SidePane side="right" label="成果物" pane={pane}>
      <div className="flex items-center justify-between border-b px-3 py-2">
        <h2 className="text-[13px] font-medium">成果物</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="閉じる"
          className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="size-4" strokeWidth={1.8} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {read.data && (
          <ArtifactContent
            path={read.data.path}
            content={read.data.content}
            onOpenArtifact={onOpenArtifact}
          />
        )}
        <FailureLine>{read.error ? `読めなかった: ${read.error.message}` : null}</FailureLine>
      </div>
      <div className="flex flex-col gap-1 border-t px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
            {dir}/{path}
          </span>
          <Button
            size="compact"
            variant="ghost"
            leadingIcon={ExternalLink}
            className="shrink-0"
            onClick={() => open.mutate()}
          >
            エディタで開く
          </Button>
        </div>
        <FailureLine>{open.error ? `開けなかった: ${open.error.message}` : null}</FailureLine>
      </div>
    </SidePane>
  )
}
