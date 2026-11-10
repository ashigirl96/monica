import type { ReactNode } from 'react'

// PROTOTYPE（Study の画面の試作、捨てる）: apps/web が Study の試作を差し込む口。本物は NotesApp の props にする。
export const studyPrototypeSlots: {
  page?: (pathname: string) => ReactNode
  rail?: (active: boolean) => ReactNode
  repoPanel?: (repo: string) => ReactNode
} = {}
