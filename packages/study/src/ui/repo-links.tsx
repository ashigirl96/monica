import { FuzzyPickerModal } from '@monica/ui'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { studiesKey } from './new-conversation.tsx'
import { activityTime } from './recency.ts'
import { typedRepoItem, unlinkedCandidates } from './repo-picker.ts'
import { FailureLine, StudyName, type StudyNamed, useScreen } from './screen.tsx'

export const studyKey = (id: string) => ['study', id] as const
const repoStudiesKey = (repo: string) => ['repo-studies', repo.toLowerCase()] as const

/** Study の画面の上の欄に並べる、紐付けた Repo の印と「+ Repo」。 */
export function LinkedRepos({ id }: { id: string }) {
  const { client } = useScreen()
  const queryClient = useQueryClient()
  const { data } = useQuery({ queryKey: studyKey(id), queryFn: () => client.get({ id }) })
  const [picking, setPicking] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  if (data === undefined) return null
  const linked = data.repos

  async function change(action: () => Promise<unknown>) {
    try {
      await action()
      setFailure(null)
    } catch (error) {
      setFailure(`変えられなかった: ${error instanceof Error ? error.message : String(error)}`)
    }
    // 紐付けは会話の行ではなく watch に流れないので、読み直させる。
    await Promise.all(
      [studyKey(id), studiesKey, ['repo-studies']].map((queryKey) =>
        queryClient.invalidateQueries({ queryKey }),
      ),
    )
  }

  return (
    <span className="flex min-w-0 shrink items-center gap-1.5">
      {linked.map((repo) => (
        <span
          key={repo}
          className="flex shrink-0 items-center gap-0.5 rounded-md border px-1.5 py-0.5 font-mono text-[12px] text-muted-foreground"
        >
          {repo}
          <button
            type="button"
            aria-label={`${repo} の紐付けを外す`}
            onClick={() => void change(() => client.repo.unlink({ id, repo }))}
            className="rounded-sm hover:bg-muted hover:text-foreground"
          >
            <X className="size-3" strokeWidth={2} />
          </button>
        </span>
      ))}
      <button
        type="button"
        onClick={() => setPicking(true)}
        className="shrink-0 rounded-md px-1.5 py-0.5 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        + Repo
      </button>
      <FailureLine>{failure}</FailureLine>
      {picking && (
        <RepoPicker
          linked={linked}
          onPick={(repo) => void change(() => client.repo.link({ id, repo }))}
          onClose={() => setPicking(false)}
        />
      )}
    </span>
  )
}

// 開くたびに描き直すので、候補は開いた時に読む。
function RepoPicker({
  linked,
  onPick,
  onClose,
}: {
  linked: readonly string[]
  onPick: (repo: string) => void
  onClose: () => void
}) {
  const { repoCandidates } = useScreen()
  const { data, isPending } = useQuery({
    queryKey: ['repo-candidates'],
    queryFn: repoCandidates,
    gcTime: 0,
  })
  if (isPending) return null
  const candidates = data ?? []
  return (
    <FuzzyPickerModal
      items={unlinkedCandidates(candidates, linked).map((repo) => ({ key: repo, label: repo }))}
      extraItem={(query) => typedRepoItem(query, candidates, linked)}
      placeholder="Repo を選ぶか owner/repo を打つ"
      onSelect={(key) => {
        if (key !== null) onPick(key)
      }}
      onClose={onClose}
    />
  )
}

type LinkedStudy = StudyNamed & { id: string; lastActivityAt: Date }

/** Repo の画面の左の欄の「Study」。紐付いた Study が無い時と読み込み中は描かない。 */
export function RepoStudies({ repo }: { repo: string }) {
  const { client } = useScreen()
  const { data, error, dataUpdatedAt } = useQuery({
    queryKey: repoStudiesKey(repo),
    queryFn: () => client.repo.studies({ repo }),
  })
  if (error) {
    return (
      <RepoStudiesFrame>
        <FailureLine>{`Study を読めなかった: ${error.message}`}</FailureLine>
      </RepoStudiesFrame>
    )
  }
  if (data === undefined || data.studies.length === 0) return null
  return <RepoStudiesList studies={data.studies} now={new Date(dataUpdatedAt)} />
}

export function RepoStudiesList({ studies, now }: { studies: readonly LinkedStudy[]; now: Date }) {
  const { spaLinkClick } = useScreen()
  return (
    <RepoStudiesFrame>
      <ul className="flex flex-col">
        {studies.map((study) => (
          <li key={study.id}>
            <a
              href={`/studies/${study.id}`}
              onClick={spaLinkClick(`/studies/${study.id}`)}
              className="flex items-baseline gap-2 rounded-md px-2.5 py-1.5 text-[0.8rem] hover:bg-muted"
            >
              <StudyName study={study} className="min-w-0 flex-1" />
              <span className="shrink-0 text-[0.7rem] text-muted-foreground tabular-nums">
                {activityTime(study.lastActivityAt, now)}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </RepoStudiesFrame>
  )
}

function RepoStudiesFrame({ children }: { children: ReactNode }) {
  return (
    <section className="mx-2 border-t pt-2 pb-2">
      <h2 className="px-2.5 pb-1 text-[0.7rem] font-medium tracking-widest text-muted-foreground uppercase">
        Study
      </h2>
      {children}
    </section>
  )
}
