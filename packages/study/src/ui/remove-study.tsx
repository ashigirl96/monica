import { type PopoverAnchor, PopoverMenu, PopoverMenuItem, pushErrorToast } from '@monica/ui'
import { useQueryClient } from '@tanstack/react-query'
import { Ellipsis } from 'lucide-react'
import { useState } from 'react'

import { studiesKey } from './new-conversation.tsx'
import { useScreen } from './screen.tsx'

/** Study の画面の上の欄の ⋯。「Study を消す」で確かめずに消す。 */
export function StudyMenu({ id }: { id: string }) {
  const { client, navigate } = useScreen()
  const queryClient = useQueryClient()
  const [anchor, setAnchor] = useState<PopoverAnchor | null>(null)
  const [removing, setRemoving] = useState(false)

  async function remove() {
    setRemoving(true)
    try {
      await client.remove({ id })
    } catch (error) {
      pushErrorToast(`消せなかった: ${error instanceof Error ? error.message : String(error)}`)
      setRemoving(false)
      return
    }
    await queryClient.invalidateQueries({ queryKey: studiesKey })
    navigate('/studies')
  }

  return (
    <>
      <button
        type="button"
        aria-label="Study の操作"
        disabled={removing}
        onClick={(e) => {
          const { top, bottom, left } = e.currentTarget.getBoundingClientRect()
          setAnchor({ top, bottom, left })
        }}
        className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
      >
        <Ellipsis className="size-[18px]" strokeWidth={1.8} />
      </button>
      {anchor && (
        <PopoverMenu anchor={anchor} onClose={() => setAnchor(null)}>
          <PopoverMenuItem
            className="text-destructive"
            onClick={() => {
              setAnchor(null)
              void remove()
            }}
          >
            Study を消す
          </PopoverMenuItem>
        </PopoverMenu>
      )}
    </>
  )
}
