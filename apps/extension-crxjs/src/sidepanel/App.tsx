import { cn, PlusIcon } from '@monica/ui'
import { useState } from 'react'

export function App() {
  const [count, setCount] = useState(0)
  return (
    <main className="flex min-h-screen flex-col gap-2 bg-slate-50 p-4 text-slate-900">
      <h1 className="text-lg font-semibold">side panel (crxjs)</h1>
      <button
        type="button"
        className={cn('flex items-center gap-1 rounded px-3 py-1 text-white', 'bg-slate-900')}
        onClick={() => setCount((n) => n + 1)}
      >
        <PlusIcon />
        count {count}
      </button>
    </main>
  )
}
