/**
 * 押すたびに今の Star を読んでから逆を送り、押下を 1 列に並べる。一覧は読み込んでいない頁と
 * 取り直す前の古い値を持つので、次の値を一覧からは決めない。
 */
export function createStarToggle(deps: {
  read: (id: string) => Promise<boolean>
  send: (id: string, starred: boolean) => Promise<unknown>
  invalidate: () => void
}): (id: string) => Promise<void> {
  let chain = Promise.resolve()
  return (id) => {
    chain = chain
      .then(async () => {
        const starred = await deps.read(id)
        await deps.send(id, !starred)
      })
      // 失敗しても、取り直した一覧が今の Star を出す。
      .catch(() => {})
      .finally(deps.invalidate)
    return chain
  }
}
