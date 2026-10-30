export type Term = {
  term: string
  ja: string
  en: string
  nuance: string
  codebase: string
}

declare module 'claude-code' {
  interface PluginState {
    glossary: { terms: Shaped<Term[]>; pending: Shaped<string[]>; open: Shaped<string | null> }
  }
}
