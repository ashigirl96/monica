// PROTOTYPE（Study の画面の試作、捨てる）: note の画面に Study の試作を差し込む。案は ?variant=A〜F で切り替える。
import { studyPrototypeSlots } from '@monica/note/ui'
import { GraduationCap } from 'lucide-react'

import { missionLine, useStudies, useStudy } from './data.ts'
import { go, PrototypeSwitcher, studyHref, useNewStudyKey, useVariant, variantOf } from './parts.tsx'
import { ListA, ScreenA } from './variant-a.tsx'
import { ListB, ScreenB } from './variant-b.tsx'
import { ListC, ScreenC } from './variant-c.tsx'
import { NewChatD, ScreenD } from './variant-d.tsx'
import { NewE, ScreenE } from './variant-e.tsx'
import { ScreenF } from './variant-f.tsx'

const LISTS = { A: ListA, B: ListB, C: ListC, D: NewChatD, E: NewE, F: () => <ListC variant="F" /> }
const SCREENS = { A: ScreenA, B: ScreenB, C: ScreenC, D: ScreenD, E: ScreenE, F: ScreenF }

function StudyPage({ pathname }: { pathname: string }) {
  const variant = useVariant()
  useNewStudyKey(variant)
  const id = /^\/studies\/([^/]+)/.exec(pathname)?.[1]
  const study = useStudy(id ?? '')
  const List = LISTS[variant]
  const Screen = SCREENS[variant]
  return (
    <div className="study-fluid min-h-dvh">
      {id === undefined ? (
        <List />
      ) : study ? (
        // 案を替えた時に、選んでいる会話や成果物を持ち越さない。
        <Screen key={`${variant}-${study.id}`} study={study} />
      ) : (
        <p className="p-10 text-muted-foreground">その Study は無い（消した後かもしれない）。</p>
      )}
      <PrototypeSwitcher />
    </div>
  )
}

function RepoStudies({ repo }: { repo: string }) {
  const studies = useStudies().filter((s) => s.linkedRepos.some((r) => r.toLowerCase() === repo.toLowerCase()))
  const variant = useVariant()
  return (
    <div className="border-t border-[var(--ink-border)] px-2 pt-2 pb-3">
      <div className="px-2.5 pb-1 font-mono text-[0.7rem] tracking-widest text-[var(--ink-muted)] uppercase">Study</div>
      {studies.length === 0 && <p className="px-2.5 py-1 text-[0.75rem] text-[var(--ink-faint)]">紐付いた Study は無い</p>}
      {studies.map((s) => (
        <a
          key={s.id}
          href={studyHref(`/studies/${s.short}`, variant)}
          onClick={(e) => {
            e.preventDefault()
            go(studyHref(`/studies/${s.short}`, variant))
          }}
          className="flex flex-col rounded-md px-2.5 py-1.5 hover:bg-[var(--ink-hover)]"
        >
          <span className="truncate text-[0.8rem] text-[var(--ink-muted)]">{variant === 'B' ? s.title : missionLine(s)}</span>
          <span className="text-[0.68rem] text-[var(--ink-faint)]">{s.lastActivityLabel}</span>
        </a>
      ))}
    </div>
  )
}

studyPrototypeSlots.page = (pathname) => <StudyPage pathname={pathname} />
studyPrototypeSlots.rail = (active) => (
  <a
    href="/studies"
    aria-label="Study"
    title="Study（試作）"
    aria-current={active ? 'page' : undefined}
    onClick={(e) => {
      e.preventDefault()
      go(studyHref('/studies', variantOf(location.search)))
    }}
    className={`flex size-9 items-center justify-center rounded-lg transition-colors ${
      active ? 'bg-muted text-foreground' : 'text-muted-foreground/60 hover:bg-muted/60 hover:text-muted-foreground'
    }`}
  >
    <GraduationCap className="size-[18px]" strokeWidth={1.8} />
  </a>
)
studyPrototypeSlots.repoPanel = (repo) => <RepoStudies repo={repo} />
