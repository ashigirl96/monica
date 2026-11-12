import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { type Choice, ChoiceSchema, type Effort, type Model } from '../contract.ts'
import { useScreen } from './screen.tsx'

const CHOICE_KEY = 'monica.study.choice'
// claude の一覧で、model を渡さない時の既定を指す行。
const DEFAULT_ROW = 'default'

const SELECT_CLASS =
  'h-7 max-w-[11rem] min-w-0 cursor-pointer truncate rounded-md bg-transparent px-1 text-[12px] text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground'

function readChoice(): Choice {
  try {
    const parsed = ChoiceSchema.safeParse(JSON.parse(localStorage.getItem(CHOICE_KEY) ?? '{}'))
    return parsed.success ? parsed.data : {}
  } catch {
    return {}
  }
}

/** 残した組を一覧に照らす。一覧に無い model と、model が持たない effort は選んでいないことにする。 */
export function pickerOf(models: readonly Model[], saved: Choice) {
  const entry =
    models.find(({ value }) => value === saved.model) ??
    models.find(({ value }) => value === DEFAULT_ROW) ??
    models[0]
  const efforts = (entry?.supportsEffort && entry.supportedEffortLevels) || []
  const effort = saved.effort && efforts.includes(saved.effort) ? saved.effort : undefined
  const choice: Choice = {
    ...(entry && entry.value !== DEFAULT_ROW && { model: entry.value }),
    ...(effort && { effort }),
  }
  return { entry, efforts, effort, choice }
}

/** Tutor に送る model と effort。一覧が届くまでは残した組をそのまま送り、選ぶ欄を出さない。 */
export function useTutorChoice() {
  const { client } = useScreen()
  const { data: models } = useQuery({
    queryKey: ['study', 'models'],
    queryFn: () => client.models({}),
    staleTime: Infinity,
    retry: false,
  })
  const [saved, setSaved] = useState(readChoice)
  const save = (next: Choice) => {
    setSaved(next)
    try {
      localStorage.setItem(CHOICE_KEY, JSON.stringify(next))
    } catch {}
  }
  if (!models || models.length === 0) return { choice: saved, picker: null }
  const { entry, efforts, effort, choice } = pickerOf(models, saved)
  const picker = (
    <>
      <select
        aria-label="model"
        title={entry?.description}
        className={SELECT_CLASS}
        value={entry?.value}
        onChange={(event) => save({ ...saved, model: event.target.value })}
      >
        {models.map(({ value, displayName, description }) => (
          <option key={value} value={value} title={description}>
            {displayName}
          </option>
        ))}
      </select>
      {efforts.length > 0 && (
        <select
          aria-label="effort"
          className={SELECT_CLASS}
          value={effort ?? ''}
          onChange={(event) => {
            const { effort: _, ...rest } = saved
            const next = event.target.value as Effort | ''
            save(next === '' ? rest : { ...rest, effort: next })
          }}
        >
          <option value="">effort: 既定</option>
          {efforts.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
      )}
    </>
  )
  return { choice, picker }
}
