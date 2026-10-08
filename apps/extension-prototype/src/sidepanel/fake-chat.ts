import { useCallback, useEffect, useRef, useState } from 'react'

import { answerFor } from './answers.ts'

export interface Message {
  id: string
  from: 'user' | 'assistant'
  text: string
}

export type Phase = 'idle' | 'thinking' | 'streaming'

export interface Chat {
  messages: Message[]
  phase: Phase
  send: (question: string) => void
  stop: () => void
  clear: () => void
}

export function useFakeChat(): Chat {
  const [messages, setMessages] = useState<Message[]>([])
  const [phase, setPhase] = useState<Phase>('idle')
  const timer = useRef<number | undefined>(undefined)
  const turn = useRef(0)

  const stop = useCallback(() => {
    window.clearTimeout(timer.current)
    setPhase('idle')
  }, [])

  const send = useCallback((question: string) => {
    window.clearTimeout(timer.current)
    const answer = answerFor(question, turn.current++)
    const answerId = crypto.randomUUID()
    setMessages((m) => [...m, { id: crypto.randomUUID(), from: 'user', text: question }])
    setPhase('thinking')
    timer.current = window.setTimeout(() => {
      setMessages((m) => [...m, { id: answerId, from: 'assistant', text: '' }])
      setPhase('streaming')
      let shown = 0
      const tick = () => {
        shown = Math.min(answer.length, shown + 2 + Math.floor(Math.random() * 5))
        setMessages((m) =>
          m.map((x) => (x.id === answerId ? { ...x, text: answer.slice(0, shown) } : x)),
        )
        if (shown < answer.length) timer.current = window.setTimeout(tick, 30)
        else setPhase('idle')
      }
      timer.current = window.setTimeout(tick, 30)
    }, 900)
  }, [])

  const clear = useCallback(() => {
    window.clearTimeout(timer.current)
    setMessages([])
    setPhase('idle')
  }, [])

  useEffect(() => () => window.clearTimeout(timer.current), [])

  return { messages, phase, send, stop, clear }
}
