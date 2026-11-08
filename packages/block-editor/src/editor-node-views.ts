import type { NodeViewConstructor } from 'prosemirror-view'

import {
  BookmarkView,
  CodeBlockView,
  ContainerView,
  DividerView,
  ImageView,
  LinkMentionView,
  NoteMentionView,
  TodoView,
  ToggleView,
} from './node-views.ts'
import type { NoteMentionOptions } from './node-views.ts'
import { SyncedBlockView } from './synced-block.ts'
import type { SyncedBlockOptions } from './synced-block.ts'
import { TableView } from './table-resize.ts'

export type EditorNodeViewOptions = NoteMentionOptions & SyncedBlockOptions

export function editorNodeViews(
  opts: EditorNodeViewOptions = {},
  syncedRegistry: Set<SyncedBlockView> = new Set(),
): Record<string, NodeViewConstructor> {
  return {
    blockContainer: (node, view, getPos) => new ContainerView(node, view, getPos),
    todo: (node, view, getPos) => new TodoView(node, view, getPos),
    toggle: (node, view, getPos) => new ToggleView(node, view, getPos),
    codeBlock: (node, view, getPos) => new CodeBlockView(node, view, getPos),
    table: (node) => new TableView(node),
    divider: () => new DividerView(),
    linkMention: (node) => new LinkMentionView(node),
    noteMention: (node) => new NoteMentionView(node, opts),
    bookmark: (node) => new BookmarkView(node),
    image: (node, view, getPos) => new ImageView(node, view, getPos),
    syncedBlock: (node, view) => new SyncedBlockView(node, view, opts, syncedRegistry),
  }
}
