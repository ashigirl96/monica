import { PopoverMenu, PopoverMenuItem, PopoverMenuSeparator } from '@tania/ui'
import { type MouseEvent as ReactMouseEvent, useCallback, useEffect, useState } from 'react'

import { displayName, type EssaySummary } from '../../../contract.ts'
import { useNoteClient } from '../../client.ts'
import { useDocumentTitle } from '../../document-title.ts'
import { altOnly } from '../../keys.ts'
import { useAutosaveContext } from '../../notes/autosave-context.tsx'
import { slashDate } from '../../notes/dates.ts'
import { useEssaysCache, useEssaysQuery } from '../../notes/queries.ts'
import { navigate, spaLinkClick } from '../../router.ts'
import { essayPath } from '../../routes.ts'
import {
  dropEssay,
  nextEssayStatus,
  patchEssay,
  pushDeletedEssay,
  restoreLastDeletedEssay,
} from './support.ts'

import '../../notes/notes.css'

/** 机に原稿を並べて見渡す。タイル = デスクマット、その中央に紙のミニチュア */
function EssayCard({
  summary,
  onMenu,
}: {
  summary: EssaySummary
  onMenu: (e: ReactMouseEvent) => void
}) {
  const writing = summary.status === 'writing'
  const path = essayPath(summary.id)
  return (
    <a
      href={path}
      onClick={spaLinkClick(path)}
      onContextMenu={onMenu}
      className="group block focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--ink-muted)]"
    >
      <div
        className={`relative aspect-[4/3] rounded-2xl transition-[transform,box-shadow] duration-150 group-hover:-translate-y-0.5 group-hover:shadow-[0_6px_18px_-8px_color-mix(in_srgb,var(--ink)_35%,transparent)] motion-reduce:transition-none motion-reduce:group-hover:translate-y-0 ${
          writing ? 'bg-[var(--essay-mat-writing)]' : 'bg-[var(--essay-mat)]'
        }`}
      >
        {writing && (
          <span className="absolute top-3 left-3 rounded-full bg-[var(--essay-badge-bg)] px-2 py-0.5 font-mono text-[0.55rem] tracking-widest text-[var(--essay-badge-ink)] uppercase">
            writing
          </span>
        )}
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="aspect-[3/4] h-[68%] w-auto min-w-0 overflow-hidden rounded-[3px] border border-[var(--ink-border)] bg-[var(--essay-sheet)] px-2.5 py-2 shadow-[0_1px_4px_color-mix(in_srgb,var(--ink)_18%,transparent)]">
            <p className="truncate text-[7px] leading-tight font-medium text-[var(--ink-text)]">
              {displayName(summary)}
            </p>
            {summary.preview && (
              <p className="mt-1 line-clamp-6 text-[6px] leading-[1.7] break-all text-[var(--ink-faint)]">
                {summary.preview}
              </p>
            )}
          </div>
        </div>
      </div>
      <h2 className="mt-3 line-clamp-2 text-[0.95rem] leading-snug text-[var(--ink-text)]">
        {displayName(summary)}
      </h2>
      <p className="mt-1 font-mono text-[0.7rem] text-[var(--ink-faint)]">
        {slashDate(summary.date)}
      </p>
    </a>
  )
}

type Menu = { x: number; y: number; target: EssaySummary }

/** /essays: Essay のカードの一覧。右クリックで status の切り替えと削除。 */
export function EssaysListPage() {
  const client = useNoteClient()
  const { resume } = useAutosaveContext()
  const { data: essays = null, error: listQueryError } = useEssaysQuery()
  const listError = listQueryError === null ? null : listQueryError.message
  const { patchEssays, invalidateEssays } = useEssaysCache()
  const [menu, setMenu] = useState<Menu | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])

  useDocumentTitle(null)

  const toggleStatus = useCallback(
    async (summary: EssaySummary) => {
      try {
        const updated = await client.essay.setStatus({
          id: summary.id,
          status: nextEssayStatus(summary.status),
        })
        if (updated.kind === 'essay') {
          patchEssays((list) => patchEssay(list, updated.id, { status: updated.status }))
        }
      } catch {
        // 手元の一覧が古いだけなので、取り直せば追いつく。
        invalidateEssays()
      }
    },
    [client, patchEssays, invalidateEssays],
  )

  const deleteEssay = useCallback(
    async (id: string) => {
      try {
        await client.remove({ id })
      } catch {
        return
      }
      pushDeletedEssay(id)
      patchEssays((list) => dropEssay(list, id))
    },
    [client, patchEssays],
  )

  const undoDelete = useCallback(async () => {
    const restored = await restoreLastDeletedEssay((id) => client.restore({ id }))
    if (restored === undefined) return
    // 編集の画面で消した Essay は保存の再試行を止めてあるので、戻したら再試行させる。
    resume(restored.id)
    // 戻した Essay の preview まで正しく並べ直すため、繕わずに取り直す。
    invalidateEssays()
  }, [client, resume, invalidateEssays])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.isComposing || !altOnly(e)) return
      if (e.code === 'KeyN') {
        e.preventDefault()
        e.stopPropagation()
        // 作れなくても次の ⌥N で作り直せる。
        void client.essay.create().then(
          (created) => navigate(essayPath(created.id)),
          () => {},
        )
        return
      }
      if (e.code === 'KeyZ') {
        e.preventDefault()
        e.stopPropagation()
        void undoDelete()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [client, undoDelete])

  useEffect(() => {
    if (menu === null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMenu()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menu, closeMenu])

  const openMenu = (e: ReactMouseEvent, target: EssaySummary) => {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, target })
  }

  return (
    <div className="notes-screen h-dvh overflow-y-auto bg-[var(--desk)]">
      <div className="mx-auto w-full max-w-[1080px] px-10 pt-10 pb-24">
        <h1 className="font-mono text-[0.8rem] tracking-widest text-[var(--ink-muted)] uppercase">
          Essays
        </h1>
        {listError ? (
          <p className="mt-10 text-sm text-destructive">{listError}</p>
        ) : essays !== null && essays.length === 0 ? (
          <p className="mt-10 text-sm text-[var(--ink-faint)]">
            No essays yet — press ⌥N to start writing
          </p>
        ) : (
          <div className="mt-8 grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-x-7 gap-y-10">
            {(essays ?? []).map((s) => (
              <EssayCard key={s.id} summary={s} onMenu={(e) => openMenu(e, s)} />
            ))}
          </div>
        )}
      </div>

      {menu && (
        <PopoverMenu anchor={{ top: menu.y, bottom: menu.y, left: menu.x }} onClose={closeMenu}>
          <PopoverMenuItem
            onClick={() => {
              closeMenu()
              void toggleStatus(menu.target)
            }}
          >
            {/* 表示と送る status が食い違わないよう、ラベルも送る status から作る。 */}
            {nextEssayStatus(menu.target.status) === 'finished'
              ? 'Mark as finished'
              : 'Move to writing'}
          </PopoverMenuItem>
          <PopoverMenuSeparator />
          <PopoverMenuItem
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => {
              closeMenu()
              void deleteEssay(menu.target.id)
            }}
          >
            Delete
          </PopoverMenuItem>
        </PopoverMenu>
      )}
    </div>
  )
}
