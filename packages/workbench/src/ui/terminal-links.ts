import { openUrl } from '@tauri-apps/plugin-opener'
import type { IBufferCell, IBufferRange, ILink, Terminal } from '@xterm/xterm'

// ghostty の src/config/url.zig 由来の URL と path の検出で、lookbehind を含むため WebKit 16.4+ (現行 WKWebView) が前提。
// path に空白を許すと prompt の `~/repo feature/branch` が branch 名まで取り込んで実在しない path になるので、空白で止める。
// bare な相対 path は `.` を含むものだけにして、`and/or` のような散文を link にしない。
// opener:default の scope が許可する scheme だけに絞る (allow-default-urls.toml: http(s)/mailto/tel)。
// ghostty は ssh/magnet/ipfs 等も対象にするが、それらは openUrl が scope 違反で reject するため、
// リンク化しても下線が出るだけで開けない。advertise する scheme = 実際に開ける scheme に揃える。
const URL_SCHEMES = String.raw`https?://|mailto:|tel:`
const IPV6 = String.raw`(?:\[[:0-9a-fA-F]+(?:[:0-9a-fA-F]*)+\](?::[0-9]+)?)`
const SCHEME_URL_CHARS = String.raw`[\w\-.~:/?#@!$&*+,;=%]`
// `\w` は ASCII だけなので、path では `/tmp/日本語.ts` が `/tmp/` で切れて親の directory が link になる。
const WORD = String.raw`\p{L}\p{M}\p{N}_`
const PATH_CHARS = String.raw`[${WORD}\-.~:\/?#@!$&*+;=%]`
const OPT_BRACKETED = String.raw`(?:[\(\[]\w*[\)\]])?`
const NO_TRAILING_PUNCT = String.raw`(?<![,.])`
const NO_TRAILING_COLON = String.raw`(?<!:)`
const TRAILING_SPACES_EOL = String.raw`(?: +(?= *$))?`
const DOTTED_LOOKAHEAD = String.raw`(?=${PATH_CHARS}*\.)`
const ROOTED_PREFIX = String.raw`(?:\.\.\/|\.\/|(?<![${WORD}])~\/|(?:[${WORD}][${WORD}\-.]*\/)*(?<![${WORD}])\$[A-Za-z_]\w*\/|\.[${WORD}][${WORD}\-.]*\/|(?<![${WORD}~\/])\/(?!\/))`
const BARE_PREFIX = String.raw`(?<!\$\d*)(?<![${WORD}])[${WORD}][${WORD}\-.]*\/`

const SCHEME_URL_BRANCH = `(?:${URL_SCHEMES})(?:${IPV6}|${SCHEME_URL_CHARS}+${OPT_BRACKETED})+${NO_TRAILING_PUNCT}`
const ROOTED_BRANCH = `${ROOTED_PREFIX}${PATH_CHARS}+${NO_TRAILING_COLON}${TRAILING_SPACES_EOL}`
const BARE_BRANCH = `${DOTTED_LOOKAHEAD}${BARE_PREFIX}${PATH_CHARS}+${NO_TRAILING_COLON}${TRAILING_SPACES_EOL}`

const LINK_REGEX = `${SCHEME_URL_BRANCH}|${ROOTED_BRANCH}|${BARE_BRANCH}`
const SCHEME_HEAD = new RegExp(`^(?:${URL_SCHEMES})`, 'i')
// buildLinks は行レンダリングごとに走るホットパス。パターンを毎回
// コンパイルし直さないよう一度だけ生成し、各呼び出しで lastIndex を巻き戻す。
// exec ループは await より前に同期で走り切るので instance 共有でも競合しない。
const LINK_PATTERN = new RegExp(LINK_REGEX, 'gu')

type Target = { kind: 'url'; uri: string } | { kind: 'path'; path: string }

// path が実在するかは Backend が cwd を基に確かめる。
export type TerminalLinkEditor = {
  resolve(candidates: string[]): Promise<(string | null)[]>
  open(path: string): void
}

// xterm の WebLinkProvider から移植: 折り返し論理行を組み立て、文字列 index を
// バッファ座標へ逆写像する。trimRight 由来のずれは mapStrIdx 側で補正する。
function windowedLineStrings(lineIndex: number, term: Terminal): [string[], number] {
  const buffer = term.buffer.active
  let line = buffer.getLine(lineIndex)
  if (!line) return [[], lineIndex]

  const lines: string[] = []
  let topIdx = lineIndex
  let bottomIdx = lineIndex
  const current = line.translateToString(true)

  if (line.isWrapped && current[0] !== ' ') {
    let length = 0
    while ((line = buffer.getLine(--topIdx)) && length < 2048) {
      const content = line.translateToString(true)
      length += content.length
      lines.push(content)
      if (!line.isWrapped || content.indexOf(' ') !== -1) break
    }
    lines.reverse()
  }

  lines.push(current)

  let length = 0
  while ((line = buffer.getLine(++bottomIdx)) && line.isWrapped && length < 2048) {
    const content = line.translateToString(true)
    length += content.length
    lines.push(content)
    if (content.indexOf(' ') !== -1) break
  }

  return [lines, topIdx]
}

function mapStrIdx(
  term: Terminal,
  lineIndex: number,
  rowIndex: number,
  stringIndex: number,
): [number, number] {
  const buffer = term.buffer.active
  const cell: IBufferCell = buffer.getNullCell()
  let start = rowIndex
  while (stringIndex) {
    const line = buffer.getLine(lineIndex)
    if (!line) return [-1, -1]
    for (let i = start; i < line.length; i++) {
      line.getCell(i, cell)
      const chars = cell.getChars()
      const width = cell.getWidth()
      if (width) {
        stringIndex -= chars.length || 1
        // trimRight で末尾セルが空のまま次行へ折り返した全角文字のずれを +1 補正する。
        if (i === line.length - 1 && chars === '') {
          const next = buffer.getLine(lineIndex + 1)
          if (next?.isWrapped) {
            next.getCell(0, cell)
            if (cell.getWidth() === 2) stringIndex += 1
          }
        }
      }
      if (stringIndex < 0) return [lineIndex, i]
    }
    lineIndex++
    start = 0
  }
  return [lineIndex, start]
}

function computeRange(
  term: Terminal,
  startLineIndex: number,
  index: number,
  length: number,
): IBufferRange | null {
  const [startY, startX] = mapStrIdx(term, startLineIndex, 0, index)
  const [endY, endX] = mapStrIdx(term, startY, startX, length)
  if (startY === -1 || startX === -1 || endY === -1 || endX === -1) return null
  return { start: { x: startX + 1, y: startY + 1 }, end: { x: endX, y: endY + 1 } }
}

export function attachTerminalLinks(
  term: Terminal,
  container: HTMLElement,
  editor: TerminalLinkEditor,
): () => void {
  // ghostty の hover_mods=super に倣い、cmd 押下中だけ下線・ポインタ・クリックを有効化する。
  let cmdHeld = false
  let currentLink: ILink | null = null

  function syncCmd(held: boolean) {
    if (held === cmdHeld) return
    cmdHeld = held
    if (currentLink?.decorations) {
      currentLink.decorations.pointerCursor = held
      currentLink.decorations.underline = held
    }
  }

  function makeLink(range: IBufferRange, text: string, target: Target): ILink {
    const link: ILink = {
      range,
      text,
      decorations: { pointerCursor: cmdHeld, underline: cmdHeld },
      activate: (event) => {
        if (!event.metaKey) return
        if (target.kind === 'url') openUrl(target.uri).catch(() => {})
        else editor.open(target.path)
      },
      hover: (event) => {
        currentLink = link
        // hover の MouseEvent は keydown 配送に依存せず実際の修飾キー状態を持つ。
        // WKWebView では bare Cmd の keydown がたまに webview に届かず cmdHeld が false の
        // まま取り残されるので、毎 hover (カーソル点滅による再問い合わせを含む) で live な
        // metaKey から補正する。decorations の tracked setter は _handleNewLink 完了後に
        // 差し込まれるため、microtask で 1 拍遅らせてから反映する。
        const meta = event.metaKey
        queueMicrotask(() => {
          if (currentLink === link) syncCmd(meta)
        })
      },
      leave: () => {
        if (currentLink === link) currentLink = null
      },
      dispose: () => {
        if (currentLink === link) currentLink = null
      },
    }
    return link
  }

  const provider = term.registerLinkProvider({
    provideLinks: (y, callback) => {
      void buildLinks(y, callback)
    },
  })

  async function buildLinks(y: number, callback: (links: ILink[] | undefined) => void) {
    const rex = LINK_PATTERN
    rex.lastIndex = 0
    const [lines, startLineIndex] = windowedLineStrings(y - 1, term)
    const text = lines.join('')
    if (!text) return callback(undefined)

    const matches: { text: string; index: number; isPath: boolean }[] = []
    let m: RegExpExecArray | null
    while ((m = rex.exec(text))) {
      if (m[0].length === 0) {
        rex.lastIndex++
        continue
      }
      matches.push({ text: m[0], index: m.index, isPath: !SCHEME_HEAD.test(m[0]) })
    }
    if (matches.length === 0) return callback(undefined)

    // 1 行の path をまとめて 1 回で問い合わせ、実在しない path は link にしない。
    const candidates = matches.filter((match) => match.isPath).map((match) => match.text)
    let resolved: (string | null)[] = []
    if (candidates.length) {
      try {
        resolved = await editor.resolve(candidates)
      } catch {
        resolved = candidates.map(() => null)
      }
      // 問い合わせの間に出力が行を書き換えていれば、先に取った位置は別の文字を指す。
      const [linesNow, startNow] = windowedLineStrings(y - 1, term)
      if (startNow !== startLineIndex || linesNow.join('') !== text) return callback(undefined)
    }

    const links: ILink[] = []
    let next = 0
    for (const match of matches) {
      let target: Target | null = null
      if (!match.isPath) {
        target = { kind: 'url', uri: match.text }
      } else {
        const path = resolved[next++]
        if (path) target = { kind: 'path', path }
      }
      if (!target) continue
      const range = computeRange(term, startLineIndex, match.index, match.text.length)
      if (range) links.push(makeLink(range, match.text, target))
    }
    callback(links.length ? links : undefined)
  }

  const onKey = (e: KeyboardEvent) => syncCmd(e.metaKey)
  const onBlur = () => syncCmd(false)
  // WKWebView の tap は mousedown を出さないため xterm ネイティブの click 発火が動かない。
  // buttons=0 の pointerdown を拾い、hover 中のリンクを cmd 押下時に発火させる。物理クリック
  // (buttons=1) は二重発火を避けるため xterm ネイティブに委ねる。
  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || !e.metaKey || e.buttons !== 0) return
    const link = currentLink
    if (!link) return
    e.preventDefault()
    e.stopPropagation()
    link.activate(e, link.text)
  }

  // keydown/keyup は document ではなく container (capture) に張る。キーイベントは
  // フォーカス中の xterm textarea に届くので、capture でつかめるのはその container
  // だけ。document に張ると生存中の全ターミナル instance が 1 回の Cmd 押下で発火し
  // (タブを開くほど増える)、Cmd autorepeat 中ずっと無駄に走る。cmd 状態は hover の
  // event.metaKey でも補正されるので、ここは「フォーカス中の即時反応」用で十分。
  container.addEventListener('keydown', onKey, true)
  container.addEventListener('keyup', onKey, true)
  window.addEventListener('blur', onBlur)
  container.addEventListener('pointerdown', onPointerDown, true)

  return () => {
    provider.dispose()
    container.removeEventListener('keydown', onKey, true)
    container.removeEventListener('keyup', onKey, true)
    window.removeEventListener('blur', onBlur)
    container.removeEventListener('pointerdown', onPointerDown, true)
  }
}
