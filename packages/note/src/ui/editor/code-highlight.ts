import { common, createLowlight } from 'lowlight'
import type { Node as PMNode } from 'prosemirror-model'
import { Plugin } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'

import { nodes } from './schema.ts'

const lowlight = createLowlight(common)
// highlight.js の shell は `$ ` の prompt を前提にした session の文法なので、script として読む。
const GRAMMAR_OF: Record<string, string> = { shell: 'bash' }

type Token = { from: number; to: number; className: string }
type HastNode = {
  type: string
  value?: string
  properties?: { className?: unknown }
  children?: HastNode[]
}

// node は immutable なので、打鍵で変わらなかった code block は前の結果を使い回す。
const cache = new WeakMap<PMNode, Token[]>()

export function codeTokens(node: PMNode): Token[] {
  const hit = cache.get(node)
  if (hit) return hit
  const tokens: Token[] = []
  const picked = node.attrs.language as string
  const language = GRAMMAR_OF[picked] ?? picked
  if (lowlight.registered(language)) {
    let offset = 0
    const walk = (n: HastNode, classes: string[]) => {
      if (n.type === 'text') {
        const end = offset + (n.value?.length ?? 0)
        if (classes.length > 0) tokens.push({ from: offset, to: end, className: classes.join(' ') })
        offset = end
        return
      }
      const own = n.properties?.className
      const next = Array.isArray(own) ? [...classes, ...(own as string[])] : classes
      for (const child of n.children ?? []) walk(child, next)
    }
    walk(lowlight.highlight(language, node.textContent) as HastNode, [])
  }
  cache.set(node, tokens)
  return tokens
}

function decorate(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = []
  doc.descendants((node, pos) => {
    if (node.type !== nodes.codeBlock) return true
    for (const token of codeTokens(node)) {
      decorations.push(
        Decoration.inline(pos + 1 + token.from, pos + 1 + token.to, { class: token.className }),
      )
    }
    return false
  })
  return DecorationSet.create(doc, decorations)
}

/** code block の言語に合わせて、highlight.js の token の class を inline decoration で付ける。 */
export function codeHighlightPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    state: {
      init: (_, state) => decorate(state.doc),
      apply: (tr, set) => (tr.docChanged ? decorate(tr.doc) : set),
    },
    props: {
      decorations(state) {
        return this.getState(state)
      },
    },
  })
}
