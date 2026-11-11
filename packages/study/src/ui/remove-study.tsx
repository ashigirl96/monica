import { type PopoverAnchor, PopoverMenu, PopoverMenuItem } from '@monica/ui'
import { useQueryClient } from '@tanstack/react-query'
import { Ellipsis } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { shortIdOf } from '../contract.ts'
import { studiesKey } from './new-conversation.tsx'
import { FailureLine, useScreen } from './screen.tsx'

const REMOVED = [
  '成果物（MISSION.md・RESOURCES.md・learning-records/・GLOSSARY.md・log.md）',
  'Prototype',
  'Playground（env/・印の付いた docker の物・この Study だけが使う nix の path）',
  '会話の記録（claude の session の記録も）',
  'Repo との紐付け',
]

/** Study の画面の上の欄の ⋯。「Study を消す」から確かめの窓を開く。 */
export function StudyMenu({ id }: { id: string }) {
  const [anchor, setAnchor] = useState<PopoverAnchor | null>(null)
  const [confirming, setConfirming] = useState(false)
  return (
    <>
      <button
        type="button"
        aria-label="Study の操作"
        onClick={(e) => {
          const { top, bottom, left } = e.currentTarget.getBoundingClientRect()
          setAnchor({ top, bottom, left })
        }}
        className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <Ellipsis className="size-[18px]" strokeWidth={1.8} />
      </button>
      {anchor && (
        <PopoverMenu anchor={anchor} onClose={() => setAnchor(null)}>
          <PopoverMenuItem
            className="text-destructive"
            onClick={() => {
              setAnchor(null)
              setConfirming(true)
            }}
          >
            Study を消す
          </PopoverMenuItem>
        </PopoverMenu>
      )}
      {confirming && <RemoveDialog id={id} onClose={() => setConfirming(false)} />}
    </>
  )
}

function RemoveDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { client, navigate } = useScreen()
  const queryClient = useQueryClient()
  const ref = useRef<HTMLDialogElement>(null)
  const [typed, setTyped] = useState('')
  const [removing, setRemoving] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const shortId = shortIdOf(id)

  useEffect(() => {
    ref.current?.showModal()
  }, [])

  async function remove() {
    setRemoving(true)
    try {
      await client.remove({ id })
    } catch (error) {
      setFailure(`消せなかった: ${error instanceof Error ? error.message : String(error)}`)
      setRemoving(false)
      return
    }
    await queryClient.invalidateQueries({ queryKey: studiesKey })
    navigate('/studies')
  }

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className="m-auto w-[28rem] rounded-lg border bg-popover p-5 text-[13px] text-popover-foreground shadow-lg backdrop:bg-black/40"
    >
      <form
        method="dialog"
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          void remove()
        }}
      >
        <h2 className="text-[15px] font-medium">Study を消す</h2>
        <div>
          <p>次のものを消す。取り消せない。</p>
          <ul className="mt-1 list-disc pl-5 text-muted-foreground">
            {REMOVED.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <p className="mt-2">Learning Preference は残る。</p>
        </div>
        <label className="flex flex-col gap-1">
          <span>
            消すには <code className="font-mono">{shortId}</code> と打つ
          </span>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoFocus
            spellCheck={false}
            className="rounded-md border bg-background px-2 py-1 font-mono"
          />
        </label>
        <FailureLine>{failure}</FailureLine>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => ref.current?.close()}
            className="rounded-md px-3 py-1 hover:bg-muted"
          >
            やめる
          </button>
          <button
            type="submit"
            disabled={typed.trim() !== shortId || removing}
            className="rounded-md bg-destructive px-3 py-1 text-white disabled:opacity-40"
          >
            消す
          </button>
        </div>
      </form>
    </dialog>
  )
}
