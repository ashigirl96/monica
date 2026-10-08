// PROTOTYPE: side panel のチャット画面を fluid-functionalism の部品で 3 通りに組み、上端の bar か ←→ で切り替える。会話は variant をまたいで残る。
import { useEffect, useState } from 'react'

import { useFakeChat } from './fake-chat.ts'
import { type Tokens, type Theme, Switcher } from './switcher.tsx'
import { VariantA } from './variant-a.tsx'
import { VariantB } from './variant-b.tsx'
import { VariantC } from './variant-c.tsx'

const variants = [
  { key: 'a', name: 'A 本家そのまま', tokens: 'fluid', View: VariantA },
  { key: 'b', name: 'B monica の字と色', tokens: 'monica', View: VariantB },
  { key: 'c', name: 'C 吹き出しなし', tokens: 'monica', View: VariantC },
] as const

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(`prototype.${key}`)
  } catch {
    return null
  }
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(`prototype.${key}`, value)
  } catch {}
}

function initialVariant(): number {
  const key = new URLSearchParams(location.search).get('variant') ?? readStored('variant')
  return Math.max(
    0,
    variants.findIndex((v) => v.key === key),
  )
}

function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')
  )
}

export function App() {
  const chat = useFakeChat()
  const [index, setIndex] = useState(initialVariant)
  const [tokensOverride, setTokensOverride] = useState<Tokens | null>(null)
  const [theme, setTheme] = useState<Theme>(() => (readStored('theme') as Theme | null) ?? 'system')
  const variant = variants[index] ?? variants[0]
  const tokens = tokensOverride ?? variant.tokens

  const go = (delta: number) => {
    setIndex((i) => (i + delta + variants.length) % variants.length)
    setTokensOverride(null)
  }

  useEffect(() => {
    const url = new URL(location.href)
    url.searchParams.set('variant', variant.key)
    history.replaceState(null, '', url)
    store('variant', variant.key)
  }, [variant.key])

  useEffect(() => {
    const html = document.documentElement
    html.dataset.tokens = tokens
    html.classList.toggle('light', theme === 'light')
    html.classList.toggle('dark', theme === 'dark')
    store('theme', theme)
  }, [tokens, theme])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return
      if (e.key === 'ArrowLeft') go(-1)
      if (e.key === 'ArrowRight') go(1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <Switcher
        label={variant.name}
        onPrev={() => go(-1)}
        onNext={() => go(1)}
        tokens={tokens}
        onTokens={setTokensOverride}
        theme={theme}
        onTheme={setTheme}
        onClear={chat.clear}
      />
      <variant.View chat={chat} />
    </div>
  )
}
