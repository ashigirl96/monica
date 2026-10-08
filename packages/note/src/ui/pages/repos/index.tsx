import { FuzzyPickerModal } from '@monica/ui'
import { useEffect, useState } from 'react'

import { useDocumentTitle } from '../../document-title.ts'
import { ctrlOnly } from '../../keys.ts'
import { useRepoCandidatesQuery } from '../../notes/queries.ts'
import { navigate } from '../../router.ts'
import { repoPath } from '../../routes.ts'
import { RepoEditor } from './editor.tsx'
import { lastRepo, setLastRepo } from './support.ts'

function openRepo(repo: string) {
  setLastRepo(repo)
  navigate(repoPath(repo))
}

/** Repo が決まっていない（`/repos`）ときの画面。前回の Repo を開くか、無ければ picker を出す。 */
function RepoChooser() {
  // 候補には ghq の checkout も入り、取るのに数秒かかりうるので、前回の Repo は候補を待たずに開く。
  const [saved] = useState(lastRepo)
  const [pickerOpen, setPickerOpen] = useState(saved === null)
  const candidatesQuery = useRepoCandidatesQuery(pickerOpen)
  const candidates = candidatesQuery.data ?? null
  useDocumentTitle(null)

  useEffect(() => {
    if (saved !== null) navigate(repoPath(saved), { replace: true })
  }, [saved])

  useEffect(() => {
    // ⌃W で picker を開き直せる（他画面と流儀を揃えて capture phase）
    function onKey(e: KeyboardEvent) {
      if (e.isComposing) return
      if (ctrlOnly(e) && e.code === 'KeyW') {
        e.preventDefault()
        e.stopPropagation()
        setPickerOpen(true)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  if (saved !== null) return null
  return (
    <div className="notes-screen h-dvh overflow-y-auto bg-[var(--paper)]">
      <div className="mx-auto w-full max-w-[760px] px-10 pt-10">
        <h1 className="font-mono text-[0.8rem] tracking-widest text-[var(--ink-muted)] uppercase">
          Repo
        </h1>
        {candidatesQuery.error ? (
          <p className="mt-10 text-sm text-destructive">{candidatesQuery.error.message}</p>
        ) : candidates !== null && candidates.length === 0 ? (
          <p className="mt-10 text-sm text-[var(--ink-faint)]">
            No repos yet — clone one with ghq, then reopen this page
          </p>
        ) : (
          <p className="mt-10 text-sm text-[var(--ink-faint)]">
            Select a repo to open — press ⌃W to pick
          </p>
        )}
      </div>
      {pickerOpen && candidates !== null && candidates.length > 0 && (
        <FuzzyPickerModal
          items={candidates.map((repo) => ({ key: repo, label: repo }))}
          placeholder="Open repo…"
          onSelect={(key) => {
            if (key !== null) openRepo(key)
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  )
}

export function ReposPage({ repo, noteId }: { repo: string | null; noteId: string | null }) {
  if (repo === null) return <RepoChooser />
  // Repo を切り替えると、取り消しの stack も含めて editor の状態を作り直す
  return <RepoEditor key={repo} repo={repo} noteId={noteId} />
}
