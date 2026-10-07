export { type Block, blockById } from './block.ts'
export { fromMarkdown } from './from-markdown.ts'
export { preview } from './preview.ts'
export { toMarkdown } from './to-markdown.ts'

/** エディタの schema を満たす最小の doc。 */
export const EMPTY_DOC = {
  type: 'doc',
  content: [
    { type: 'blockGroup', content: [{ type: 'blockContainer', content: [{ type: 'paragraph' }] }] },
  ],
}
