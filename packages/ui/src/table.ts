// 幅は文字数ではなく端末の桁で測る。全角文字は 1 文字で 2 桁を取る。
export function table(rows: string[][]): string {
  const [header] = rows
  if (!header) return ''
  const widths = header.map((_, column) =>
    Math.max(...rows.map((row) => Bun.stringWidth(row[column] ?? ''))),
  )
  return rows
    .map((row) =>
      row
        .map((cell, column) => {
          const width = widths[column]
          return width === undefined ? cell : cell + ' '.repeat(width - Bun.stringWidth(cell))
        })
        .join('  ')
        .trimEnd(),
    )
    .join('\n')
}
