export type Section = 'daily' | 'essays' | 'repos'

export type KeyFacts = {
  key: string
  code: string
  meta: boolean
  ctrl: boolean
  alt: boolean
  shift: boolean
  composing: boolean
}

export type NoteCommand =
  | 'toggleZen'
  | 'goDaily'
  | 'goEssays'
  | 'goRepos'
  | 'cycleAmbient'
  | 'toggleDensity'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomReset'
  | 'create'
  | 'remove'
  | 'undoRemove'
  | 'toggleStar'
  | 'switchEssayList'
  | 'next'
  | 'prev'
  | 'toggleStatus'
  | 'openPicker'

const MODS = {
  alt: (k: KeyFacts) => k.alt && !k.meta && !k.ctrl && !k.shift,
  ctrl: (k: KeyFacts) => k.ctrl && !k.meta && !k.alt && !k.shift,
  // ⌥X と ⇧⌥X を 1 つの命令で受け、向きは処理の側で shift を見て決める。
  altAnyShift: (k: KeyFacts) => k.alt && !k.meta && !k.ctrl,
  // ⌘+ は US 配列で ⇧ を伴うので、⇧ は問わない。
  metaOrCtrl: (k: KeyFacts) => (k.meta || k.ctrl) && !k.alt,
}

/** section の無い行は全画面で効く。composing の印のある行は IME の変換中も取る。 */
export type NoteKeyRow = {
  mods: keyof typeof MODS
  codes?: string[]
  keys?: string[]
  command: NoteCommand
  section?: Section
  composing?: true
}

const alt = (code: string, command: NoteCommand, section?: Section): NoteKeyRow => ({
  mods: 'alt',
  codes: [code],
  command,
  section,
})

const editing = (section: Section): NoteKeyRow[] => [
  alt('KeyN', 'create', section),
  { mods: 'alt', codes: ['Backspace', 'Delete'], command: 'remove', section },
  alt('KeyZ', 'undoRemove', section),
  alt('KeyS', 'toggleStar', section),
  alt('KeyJ', 'next', section),
  alt('KeyK', 'prev', section),
]

export const NOTE_KEYS: NoteKeyRow[] = [
  alt('KeyB', 'toggleZen'),
  { mods: 'ctrl', codes: ['Digit1'], command: 'goDaily' },
  { mods: 'ctrl', codes: ['Digit2'], command: 'goEssays' },
  { mods: 'ctrl', codes: ['Digit3'], command: 'goRepos' },
  // ambient は文書に触らないので、変換中に奪っても害がない。macOS の ⌥; の key は "…" なので code で見る。
  { mods: 'altAnyShift', codes: ['Semicolon'], command: 'cycleAmbient', composing: true },
  alt('KeyD', 'toggleDensity'),
  // JIS 配列は ; のキーに + があり、Chrome はそこでの ⌘; を拡大として扱う。
  {
    mods: 'metaOrCtrl',
    keys: ['+', '=', ';'],
    codes: ['NumpadAdd'],
    command: 'zoomIn',
    composing: true,
  },
  {
    mods: 'metaOrCtrl',
    keys: ['-'],
    codes: ['NumpadSubtract'],
    command: 'zoomOut',
    composing: true,
  },
  { mods: 'metaOrCtrl', keys: ['0'], codes: ['Numpad0'], command: 'zoomReset', composing: true },
  alt('KeyJ', 'next', 'daily'),
  alt('KeyK', 'prev', 'daily'),
  ...editing('essays'),
  { mods: 'alt', codes: ['KeyH', 'KeyL'], command: 'switchEssayList', section: 'essays' },
  { mods: 'ctrl', codes: ['KeyW'], command: 'toggleStatus', section: 'essays' },
  ...editing('repos'),
  { mods: 'ctrl', codes: ['KeyW'], command: 'openPicker', section: 'repos' },
]

function matches(row: NoteKeyRow, k: KeyFacts): boolean {
  if (!MODS[row.mods](k)) return false
  return Boolean(row.codes?.includes(k.code) || row.keys?.includes(k.key))
}

function sectionFirst(rows: NoteKeyRow[]): NoteKeyRow[] {
  return [...rows.filter((r) => r.section), ...rows.filter((r) => !r.section)]
}

export function commandOf(section: Section | null, k: KeyFacts): NoteCommand | undefined {
  return sectionFirst(NOTE_KEYS).find(
    (r) => (r.section === undefined || r.section === section) && matches(r, k),
  )?.command
}

/** false を返すと、キーを取らずに既定の動作（editor の入力など）に任せる。 */
export type NoteKeyHandler = (k: KeyFacts) => unknown
export type NoteKeyHandlers = Partial<Record<NoteCommand, NoteKeyHandler>>

export function createNoteKeys(rows: NoteKeyRow[] = NOTE_KEYS) {
  const ordered = sectionFirst(rows)
  const registered: { section: Section | null; handlers: NoteKeyHandlers }[] = []

  function handlerFor(row: NoteKeyRow): NoteKeyHandler | undefined {
    const section = row.section ?? null
    return registered.find((r) => r.section === section && r.handlers[row.command])?.handlers[
      row.command
    ]
  }

  return {
    register(section: Section | null, handlers: NoteKeyHandlers): () => void {
      const entry = { section, handlers }
      registered.push(entry)
      return () => {
        const i = registered.indexOf(entry)
        if (i !== -1) registered.splice(i, 1)
      }
    },
    press(k: KeyFacts): boolean {
      for (const row of ordered) {
        if (k.composing && !row.composing) continue
        if (!matches(row, k)) continue
        const handler = handlerFor(row)
        if (handler === undefined) continue
        return handler(k) !== false
      }
      return false
    },
  }
}

export const noteKeys = createNoteKeys()

export function keyFacts(e: KeyboardEvent): KeyFacts {
  return {
    key: e.key,
    code: e.code,
    meta: e.metaKey,
    ctrl: e.ctrlKey,
    alt: e.altKey,
    shift: e.shiftKey,
    composing: e.isComposing,
  }
}

function onKey(e: KeyboardEvent) {
  if (!noteKeys.press(keyFacts(e))) return
  e.preventDefault()
  e.stopPropagation()
}

/** capture phase で張るのは、editor（ProseMirror）に食われる前に取るため。 */
export function listenNoteKeys(): () => void {
  window.addEventListener('keydown', onKey, true)
  return () => window.removeEventListener('keydown', onKey, true)
}
