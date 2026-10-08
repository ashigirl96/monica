import { cn } from './fluid/lib/utils.ts'

export type Tokens = 'fluid' | 'monica'
export type Theme = 'system' | 'light' | 'dark'

function Segment<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
}) {
  return (
    <div className="flex overflow-hidden rounded border border-white/25">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn('px-1.5', o.value === value ? 'bg-white text-black' : 'text-white/70')}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Switcher({
  label,
  onPrev,
  onNext,
  tokens,
  onTokens,
  theme,
  onTheme,
  onClear,
}: {
  label: string
  onPrev: () => void
  onNext: () => void
  tokens: Tokens
  onTokens: (tokens: Tokens) => void
  theme: Theme
  onTheme: (theme: Theme) => void
  onClear: () => void
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 bg-[#111] px-2 py-1 font-mono text-[11px] leading-5 text-white">
      <div className="flex items-center gap-1">
        <button type="button" onClick={onPrev} className="px-1 text-white/70 hover:text-white">
          ←
        </button>
        <span className="text-center">{label}</span>
        <button type="button" onClick={onNext} className="px-1 text-white/70 hover:text-white">
          →
        </button>
      </div>
      <Segment
        options={[
          { value: 'fluid', label: 'fluid' },
          { value: 'monica', label: 'monica' },
        ]}
        value={tokens}
        onChange={onTokens}
      />
      <Segment
        options={[
          { value: 'system', label: 'auto' },
          { value: 'light', label: '☀' },
          { value: 'dark', label: '☾' },
        ]}
        value={theme}
        onChange={onTheme}
      />
      <button type="button" onClick={onClear} className="text-white/70 hover:text-white">
        消す
      </button>
    </div>
  )
}
