export type Mode = 'ascii' | 'off'
export type Rendered = { kind: 'ascii'; text: string }

declare module 'claude-code' {
  interface PluginState {
    'mermaid-render': { mode: Mode; rendered: Record<string, Rendered> }
  }
}
