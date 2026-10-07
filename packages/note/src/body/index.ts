export { imageReferences } from './images.ts'
export { type Block, blockById } from './block.ts'
export { preview } from './preview.ts'

/** エディタの schema を満たす最小の doc。 */
export const EMPTY_DOC = {
  type: 'doc',
  content: [
    { type: 'blockGroup', content: [{ type: 'blockContainer', content: [{ type: 'paragraph' }] }] },
  ],
}
