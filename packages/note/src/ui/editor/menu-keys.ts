import type { Node as PMNode } from 'prosemirror-model'
import { PluginKey } from 'prosemirror-state'

import type { LinkMetadata } from '../../contract.ts'

export type PreviewKind = 'url' | 'mention' | 'bookmark'

export type LinkMenuActiveState = {
  active: true
  from: number
  url: string
  index: number
  /** doc に反映済みの表現 */
  preview: PreviewKind
  /** 現 preview が期待する selection.head。ずれたら外部操作とみなして確定クローズ */
  caret: number
  /** bookmark preview 時の bookmark node 位置 */
  bookmarkPos: number | null
  /** URL 単独段落を bookmark 化した際に追加した空 paragraph container の位置 */
  extraParaPos: number | null
  /** OGP metadata。未取得の間は URL だけの placeholder で preview する */
  meta: LinkMetadata | null
  metaDone: boolean
  /** Enter 済みで metadata 待ち。到着後に attrs を差し替えて閉じる */
  confirmPending: boolean
}

export type LinkMenuState = { active: false } | LinkMenuActiveState

export type NoteMentionItem = {
  id: string
  displayName: string
  /** dropdown のサブラベル（ノート本文の先頭行） */
  preview: string | null
}

export type NoteMentionMenuActiveState = {
  active: true
  /** 最初の `[` の位置 */
  pos: number
  query: string
  index: number
  /** 検索結果。query より遅れて到着するので loadedQuery で鮮度を判定する */
  items: NoteMentionItem[]
  loadedQuery: string | null
}

export type NoteMentionMenuState = { active: false } | NoteMentionMenuActiveState

export type PasteMenuActiveState = {
  active: true
  /** 挿入 range の先頭。start より前は触らないので全遷移を通じて安定アンカー。 */
  start: number
  /** 0 = Paste（plain）, 1 = Paste and sync */
  index: number
  plain: PMNode[]
  synced: PMNode[]
}

export type PasteMenuState = { active: false } | PasteMenuActiveState

export type SlashState =
  | { active: false }
  | { active: true; pos: number; query: string; index: number }

export type TableMenuState =
  | { active: false }
  | { active: true; x: number; y: number; index: number }

// slash-menu と note-mention-menu は互いの active を見て二重 open を防ぐ
// （project の表示名 "owner/repo" を `[[` メニューで検索中に `/` で slash が開く等）。
// key と state の型を各 plugin ファイルに置くと相互参照が循環 import になるため、ここに集約する。
export const slashKey = new PluginKey<SlashState>('journalSlashMenu')
export const noteMentionMenuKey = new PluginKey<NoteMentionMenuState>('journalNoteMentionMenu')
// paste-menu（Paste / Paste and sync）。paste 直後にだけ開き、id を振るだけでない doc 変更で自動的に閉じる。
export const pasteMenuKey = new PluginKey<PasteMenuState>('journalPasteMenu')
// table-menu（セル右クリック: 行・列の挿入 / 削除）。doc 変更・selection 移動で自動的に閉じる。
export const tableMenuKey = new PluginKey<TableMenuState>('journalTableMenu')
// link-menu（URL paste 直後の Paste as…）。table-menu は開いている間 contextmenu を譲る。
export const linkMenuKey = new PluginKey<LinkMenuState>('journalLinkMenu')
