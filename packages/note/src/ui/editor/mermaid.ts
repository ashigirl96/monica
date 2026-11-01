type MermaidResult = { svg: string } | { error: string }

export const MERMAID_LANGUAGE = 'mermaid'

// 色は var() で渡し、見た目の設定の切り替えに描き直しなしで追従させる。
// bg は文字色を color-mix で作る元なので、テーマが透明にする --jb-paper でなく不透明な --background にする。
const mix = (percent: number) => `color-mix(in srgb, var(--jb-ink) ${percent}%, var(--background))`
// SVG は省いた色を var(--muted) のように読むので、UI の同名の token を拾わないよう全部渡す。
const COLORS = {
  bg: 'var(--background)',
  fg: 'var(--jb-ink)',
  line: mix(50),
  accent: mix(85),
  muted: mix(60),
  surface: mix(3),
  border: mix(20),
  transparent: true,
}

// beautiful-mermaid は elkjs と合わせて約 1.9MB あるので、図を初めて描くときにだけ読み込む。
export async function renderMermaid(source: string): Promise<MermaidResult> {
  try {
    const { renderMermaidSVG } = await import('beautiful-mermaid')
    const svg = renderMermaidSVG(source, COLORS)
    // SVG は Google Fonts を @import するので、外への通信を起こさないよう落とす。
    return { svg: svg.replace(/@import url\([^)]*\);/g, '') }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}
