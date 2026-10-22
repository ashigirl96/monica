import { renderMermaidASCII } from 'beautiful-mermaid'

// beautiful-mermaid の ASCII は 1 文字を 1 cell と数えるので、全角の後ろに印を挟んで 2 cell 取らせ、描いた後で消す。
const WIDE =
  /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}\u3000-\u303f\uff01-\uff60\uffe0-\uffe6]/gu
// 印は id の中にも入るので、parser が id に許す \p{L} のうち文章に出ない U+A66E を使う。
const SPACER = '\ua66e'

// `A -.label.-> B` などのラベル付きの辺を、beautiful-mermaid が読める `A -.->|label| B` に書き換える。
function normalizeEdges(source: string): string {
  return source
    .replace(/-\.\s*([^.|\n]+?)\s*\.->/g, '-.->|$1|')
    .replace(/--\s+([^-|\n]+?)\s+-->/g, '-->|$1|')
    .replace(/==\s+([^=|\n]+?)\s+==>/g, '==>|$1|')
}

const BORDER = new Set(['─', '═', '┬', '┴', '┼'])

// 矢印の字形は cell の中ほどに描かれ、枠の線は cell の縦の中央を通るので、別の行だと間に隙間が見える。
// 縦の矢印を、指している箱の枠の行へ移して隙間を消す。全角の印を消す前の、1 文字 1 cell の段で動かす。
function arrowsIntoBorders(text: string): string {
  const grid = text.split('\n').map((line) => Array.from(line))
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r]!
    for (let c = 0; c < row.length; c++) {
      const target = row[c] === '▼' ? grid[r + 1] : row[c] === '▲' ? grid[r - 1] : undefined
      if (target && BORDER.has(target[c] ?? '')) {
        target[c] = row[c]!
        row[c] = '│'
      }
    }
  }
  return grid.map((cells) => cells.join('')).join('\n')
}

const VERTICAL = new Set(['│', '┆', '┊', '║', '╎'])
const DETACHED_START = /│( {1,3})├([─┄╌═])/g

// 1 つの箱から右へ出る辺が複数あると、beautiful-mermaid は辺の始まり（├）を箱の枠から数列離して描く。
// 上下に縦線の無い ├ は分岐ではなく離れた始まりなので、枠を ├ にして間を辺の線で埋める。
function attachDetachedEdges(text: string): string {
  const lines = text.split('\n')
  return lines
    .map((line, r) =>
      line.replace(DETACHED_START, (whole, gap: string, stroke: string, at: number) => {
        const col = Array.from(line.slice(0, at)).length + 1 + gap.length
        const isJunction = [lines[r - 1], lines[r + 1]].some((other) =>
          VERTICAL.has(Array.from(other ?? '')[col] ?? ''),
        )
        return isJunction ? whole : `├${stroke.repeat(gap.length + 1)}${stroke}`
      }),
    )
    .join('\n')
}

const { source } = (await Bun.stdin.json()) as { source: string }
const widened = normalizeEdges(source).replace(WIDE, (c) => c + SPACER)
let text = ''
try {
  // 既定の余白は縦に長すぎる。paddingY を 3 より詰めると辺のラベルが箱の枠に重なる。
  const drawn = renderMermaidASCII(widened, { colorMode: 'none', paddingY: 3, boxBorderPadding: 0 })
  text = attachDetachedEdges(arrowsIntoBorders(drawn)).replaceAll(SPACER, '')
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
if (text.trim() === '') {
  console.error('beautiful-mermaid drew nothing for this diagram')
  process.exit(1)
}
console.log(JSON.stringify({ text }))
